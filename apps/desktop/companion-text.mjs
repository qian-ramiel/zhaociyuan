import { Lexer } from 'marked';

function tokenText(token) {
  if (['html', 'def', 'checkbox'].includes(token.type)) return '';
  if (['space', 'br', 'hr'].includes(token.type)) return '\n';
  if (token.type === 'list') return token.items.map(tokenText).join('\n') + '\n';
  if (token.type === 'table') {
    return [token.header, ...token.rows].map((row) => row.map(tokenText).join(' / ')).join('\n') + '\n';
  }
  const text = token.tokens ? token.tokens.map(tokenText).join('') : token.text || '';
  return text + (['paragraph', 'heading', 'blockquote', 'list_item', 'code'].includes(token.type) ? '\n' : '');
}

export function companionText(value) {
  let text = String(value || '');
  // Legacy history may contain the entire structured reply after metadata validation failed.
  const unwrapped = text.trim().replace(/^```(?:json)?\s*\n/i, '').replace(/\n```\s*$/, '');
  if (/^\{\s*"text"\s*:/.test(unwrapped)) {
    try { const parsed = JSON.parse(unwrapped); text = typeof parsed.text === 'string' ? parsed.text : ''; }
    catch { return '这条回复的格式异常，可在聊天窗口查看原文。'; }
  }
  // Tokens are converted directly to text. Never execute or inject model-generated HTML.
  return Lexer.lex(text).map(tokenText).join('').replace(/\n{3,}/g, '\n\n').trim();
}
