import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';

export function createSessionStore({ ttlMs = 60 * 60 * 1000, maxSessions = 100, now = Date.now } = {}) {
  const sessions = new Map();
  function prune() {
    for (const [id, session] of sessions) {
      if (!session.busy && now() - session.lastUsed >= ttlMs) sessions.delete(id);
    }
  }
  return {
    create(chat) {
      prune();
      if (sessions.size >= maxSessions) throw new AppError(503, 'SESSION_LIMIT', 'Folion is busy. Please try again later.');
      const session = { id: randomUUID(), chat, messages: [], jobCard: null, busy: false, lastUsed: now() };
      sessions.set(session.id, session);
      return session;
    },
    get(id) {
      prune();
      const session = sessions.get(id);
      if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'This enquiry has expired. Start a new enquiry to continue.');
      session.lastUsed = now();
      return session;
    },
    delete(id) { sessions.delete(id); },
    prune,
  };
}

export function publicSession(session) {
  return { id: session.id, messages: session.messages, jobCard: session.jobCard };
}
