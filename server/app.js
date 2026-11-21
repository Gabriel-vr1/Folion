import express from 'express';
import { fileURLToPath } from 'node:url';
import { createAgent } from './agent.js';
import { createSessionStore, publicSession } from './sessions.js';
import { AppError } from './errors.js';

export function createApp({ agent = createAgent(), store = createSessionStore() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', express.json({ limit: '20kb', strict: true }));
  app.get('/api/health', (req, res) => res.json({ configured: agent.configured, model: agent.model }));
  app.post('/api/sessions', (req, res) => res.status(201).json(publicSession(store.create(agent.createChat()))));
  app.param('id', (req, res, next, id) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return next(new AppError(400, 'INVALID_SESSION', 'Invalid enquiry identifier. Start a new enquiry.'));
    }
    next();
  });
  app.get('/api/sessions/:id', (req, res) => res.json(publicSession(store.get(req.params.id))));
  app.delete('/api/sessions/:id', (req, res) => {
    const session = store.get(req.params.id);
    if (session.busy) throw new AppError(409, 'ENQUIRY_BUSY', 'Please wait for the current reply before starting again.');
    store.delete(session.id);
    res.sendStatus(204);
  });
  app.post('/api/sessions/:id/messages', async (req, res) => {
    if (!req.is('application/json')) throw new AppError(415, 'JSON_REQUIRED', 'Send the message as JSON.');
    const message = req.body?.message;
    if (typeof message !== 'string' || !message.trim() || message.length > 4000) {
      throw new AppError(400, 'INVALID_MESSAGE', 'Enter a message between 1 and 4,000 characters.');
    }
    const session = store.get(req.params.id);
    if (session.busy) throw new AppError(409, 'ENQUIRY_BUSY', 'Please wait for the current reply before sending another message.');
    if (session.messages.length >= 80) throw new AppError(422, 'TURN_LIMIT', 'This enquiry has reached 40 messages. Start a new enquiry to continue.');
    session.busy = true;
    try {
      const result = await agent.respond(session, message.trim());
      session.messages.push({ role: 'user', text: message.trim() }, { role: 'assistant', text: result.reply });
      session.jobCard = result.jobCard;
      res.json(publicSession(session));
    } finally {
      session.busy = false;
      session.lastUsed = Date.now();
    }
  });
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'This API route does not exist.' } }));
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') return res.status(413).json({ error: { code: 'MESSAGE_TOO_LARGE', message: 'This request is too large. Keep your message under 4,000 characters.' } });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'The request could not be read. Please send valid JSON.' } });
    const known = error instanceof AppError;
    res.status(known ? error.status : 500).json({ error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : 'Something went wrong. Please try again.' } });
  });
  return app;
}
