const $ = selector => document.querySelector(selector);
const messages = $('#messages');
const input = $('#message');
const errorBox = $('#error');
const sessionKey = 'folion.enquiry';
let sessionId = null;
let busy = false;

function savedId() { try { return sessionStorage.getItem(sessionKey); } catch { return null; } }
function saveId(value) {
  sessionId = value;
  try { if (value) sessionStorage.setItem(sessionKey, value); else sessionStorage.removeItem(sessionKey); } catch { /* Works without browser storage until refresh. */ }
}
function showError(message = '') { errorBox.textContent = message; errorBox.hidden = !message; }
function setBusy(value) {
  busy = value;
  $('#send').disabled = value;
  $('#new-enquiry').disabled = value;
  input.disabled = value;
  $('#loading').hidden = !value;
  $('#message-form').setAttribute('aria-busy', String(value));
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  if (response.status === 204) return null;
  let data;
  try { data = await response.json(); } catch { throw new Error('Folion could not read the server response. Please try again.'); }
  if (!response.ok) {
    const error = new Error(data.error?.message || 'Something went wrong. Please try again.');
    error.code = data.error?.code;
    throw error;
  }
  return data;
}
function addMessage(role, text) {
  const article = document.createElement('article');
  article.className = `message ${role}`;
  const label = document.createElement('span');
  label.className = 'message-label';
  label.textContent = role === 'user' ? 'You' : 'Folion';
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  article.append(label, paragraph);
  messages.append(article);
  return article;
}
function renderCard(card) {
  for (const field of document.querySelectorAll('[data-field]')) {
    const value = card?.[field.dataset.field];
    field.textContent = value || 'Not provided';
    field.classList.toggle('empty', !value);
  }
  $('#card-status').textContent = card?.status || 'Waiting for your enquiry';
  $('#card-status').classList.toggle('ready', Boolean(card?.readyForReview));
  $('#summary-help').textContent = card?.readyForReview
    ? 'Review the details below. Add or correct anything in the conversation. This request has not been sent to a business.'
    : 'Your request takes shape as we chat. You can add or correct a detail at any time.';
}
function render(session) {
  messages.replaceChildren();
  addMessage('assistant', 'Hi, I’m Folion. Tell me which appliance needs attention and what’s happening with it. If you know the brand and your suburb, include those too.');
  if (!session?.messages?.length) {
    const example = document.createElement('button');
    example.type = 'button';
    example.className = 'example';
    example.textContent = 'Try an example: “My Samsung washing machine has stopped spinning.”';
    example.addEventListener('click', () => { input.value = 'My Samsung washing machine has stopped spinning.'; input.focus(); });
    messages.lastElementChild.append(example);
  }
  for (const message of session?.messages || []) addMessage(message.role, message.text);
  renderCard(session?.jobCard);
  messages.scrollTop = messages.scrollHeight;
}
$('#message-form').addEventListener('submit', async event => {
  event.preventDefault();
  const message = input.value.trim();
  if (busy || !message) return;
  showError();
  setBusy(true);
  let pending;
  try {
    if (!sessionId) {
      const session = await api('/api/sessions', { method: 'POST', body: '{}' });
      saveId(session.id);
    }
    pending = addMessage('user', message);
    messages.scrollTop = messages.scrollHeight;
    const session = await api(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ message }) });
    input.value = '';
    render(session);
  } catch (error) {
    pending?.remove();
    if (error.code === 'SESSION_NOT_FOUND') saveId(null);
    showError(error instanceof TypeError ? 'Could not reach Folion. Check your connection and try again.' : error.message);
  } finally { setBusy(false); input.focus(); }
});
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#message-form').requestSubmit(); }
});
$('#new-enquiry').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  showError();
  try {
    if (sessionId) {
      try { await api(`/api/sessions/${sessionId}`, { method: 'DELETE' }); }
      catch (error) { if (error.code !== 'SESSION_NOT_FOUND') throw error; }
    }
    saveId(null);
    input.value = '';
    render(null);
  } catch (error) { showError(error.message); }
  finally { setBusy(false); input.focus(); }
});

async function initialise() {
  render(null);
  setBusy(true);
  try {
    const health = await api('/api/health');
    if (!health.configured) showError('The assistant is not configured yet. Add GEMINI_API_KEY to the server’s .env file and restart Folion.');
    const id = savedId();
    if (id) {
      try { const session = await api(`/api/sessions/${id}`); saveId(id); render(session); }
      catch (error) {
        if (error.code === 'SESSION_NOT_FOUND' || error.code === 'INVALID_SESSION') { saveId(null); showError('Your earlier enquiry has expired. You can start a fresh one below.'); }
        else throw error;
      }
    }
  } catch (error) { showError(error instanceof TypeError ? 'Could not reach Folion. Check that the server is running, then refresh.' : error.message); }
  finally { setBusy(false); }
}
await initialise();
