import {
  json,
  onlyPost,
  parseBody,
  readJsonResponse,
  upstreamMessage,
  fetchWithTimeout,
} from './_shared/utils.mjs';

const MODELS = [
  process.env.GROQ_ROUTER_MODEL,
  'qwen/qwen3.8-27b',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
].filter(Boolean);

function extractJson(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(clean); } catch {}
  const a = clean.indexOf('{');
  const b = clean.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(clean.slice(a, b + 1)); } catch {}
  }
  return null;
}

function normalizeDecision(d) {
  if (!d || typeof d !== 'object') return null;
  const allowed = new Set(['export_current', 'export_named', 'generate_then_export', 'none']);
  const intent = allowed.has(String(d.intent || '')) ? String(d.intent) : 'none';
  const format = String(d.format || '').toLowerCase() === 'pdf' ? 'pdf' : 'docx';
  return {
    intent,
    format,
    target_title: d.target_title == null ? null : String(d.target_title).trim() || null,
    chat_id: d.chat_id == null ? null : String(d.chat_id).trim() || null,
    clean_prompt: d.clean_prompt == null ? null : String(d.clean_prompt).trim() || null,
  };
}

export const handler = async (event) => {
  const preflight = onlyPost(event);
  if (preflight) return preflight;

  try {
    const body = parseBody(event);
    const text = String(body.text || '').trim();
    if (!text) return json(200, { ok: true, decision: { intent: 'none', format: 'docx', target_title: null, chat_id: null, clean_prompt: null } });

    // Important: Groq is optional for app stability. If the key is absent,
    // the browser falls back to a local classifier instead of producing a 500.
    const apiKey = String(process.env.GROQ_API_KEY || '').trim();
    if (!apiKey) return json(200, { ok: false, fallback: true, reason: 'GROQ_API_KEY no configurada.' });

    const chats = Array.isArray(body.chats) ? body.chats.slice(0, 80) : [];
    const currentId = String(body.current_chat_id || '');
    const currentTitle = String(body.current_chat_title || '');
    const chatList = chats.map(c => `- ${String(c.id || '')}: ${String(c.title || '')}`).join('\n') || '(sin chats listados)';

    const system = `Eres un router determinista de órdenes de exportación para Elix AI. NO respondas al usuario. Devuelve SOLO un objeto JSON válido, sin Markdown ni comentarios.

Tu única tarea es clasificar el texto en UNA de estas intenciones:
1. export_current: el usuario SOLO quiere exportar/convertir/descargar el chat o conversación ya existente/actual. Ejemplos: "convierte todo el chat en Word", "dame esta conversación en docx", "exporta lo anterior a Word".
2. export_named: el usuario quiere exportar un chat YA EXISTENTE identificado por su nombre/título. Ejemplos: "pásame el chat de números reales a Word", "exporta la conversación química orgánica a docx".
3. generate_then_export: el usuario pide CREAR, INVESTIGAR, EXPLICAR, RESOLVER, REDACTAR, ANALIZAR o desarrollar contenido nuevo Y además pide que al terminar se entregue en Word/PDF. Ejemplos: "investiga sobre la segunda guerra mundial y hazme un Word de eso", "explícame fotosíntesis y pásamelo a docx". Para este caso, clean_prompt DEBE contener solo la tarea intelectual, eliminando por completo la orden de Word/PDF/archivo. Debe seguir siendo una instrucción natural y completa para el modelo principal.
4. none: no hay una intención real de exportación.

Reglas:
- Tolera faltas de escritura de Word/DOCX como dox, dovx, dcx, wodr, wrd, doc, etc. Tolera errores parecidos de PDF.
- Si hay una tarea nueva sustantiva y además una petición de archivo, elige generate_then_export, NO export_current.
- Si el usuario dice "este chat", "todo el chat", "esta conversación", "historial", "todo lo anterior" y no pide crear contenido nuevo, elige export_current.
- Para export_named, intenta asociar el nombre pedido a uno de los títulos disponibles. Si hay coincidencia clara, devuelve chat_id y target_title exactos del listado. Si no, deja chat_id en null y target_title con el texto objetivo.
- format debe ser "docx" o "pdf". Si dice Word/doc/dox/dovx, usa docx.
- Para export_current/export_named, clean_prompt debe ser null.
- Para generate_then_export, clean_prompt nunca debe contener palabras de exportación, Word, DOCX, PDF, descargar, archivo o equivalentes.

Esquema exacto:
{"intent":"export_current|export_named|generate_then_export|none","format":"docx|pdf","target_title":null|string,"chat_id":null|string,"clean_prompt":null|string}`;

    const user = `TEXTO DEL USUARIO:\n${text}\n\nCHAT ACTUAL: ${currentId} | ${currentTitle}\n\nCHATS DISPONIBLES:\n${chatList}`;
    const failures = [];

    for (const model of [...new Set(MODELS)]) {
      try {
        const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature: 0,
            max_tokens: 320,
          }),
        }, 12000);

        const data = await readJsonResponse(response);
        if (!response.ok) {
          failures.push(`${model}: ${upstreamMessage(data, `${response.status} ${response.statusText}`)}`);
          continue;
        }

        const content = String(data?.choices?.[0]?.message?.content || '').trim();
        const parsed = normalizeDecision(extractJson(content));
        if (!parsed) {
          failures.push(`${model}: respuesta JSON inválida`);
          continue;
        }

        return json(200, { ok: true, model: 'Elix Router', decision: parsed });
      } catch (error) {
        failures.push(`${model}: ${error?.message || error}`);
      }
    }

    // Never take down the app just because the router failed.
    return json(200, { ok: false, fallback: true, reason: failures.join(' | ') || 'Router no disponible.' });
  } catch (error) {
    console.error('elix-export-router', error);
    return json(200, { ok: false, fallback: true, reason: error?.message || 'Router no disponible.' });
  }
};
