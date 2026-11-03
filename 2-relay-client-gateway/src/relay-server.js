'use strict';

/**
 * Relay Client & Gateway (OpenAI / Gemini Compatible with Real-Time SSE Streaming,
 * Plaintext Thought Summary `reasoning_content` / `thought: true`, and Gemini
 * `thoughtSignature` Multi-Turn Round-Tripping)
 */

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const {
  extractMinimalCookies,
  computeSessionAnchor,
  computeAccountId,
  resolveModelAlias,
  RelayAccountStore,
  renderLoginHtml,
  renderDashboardHtml,
} = require('./dashboard');
const {
  rotateGoogleCookies,
  applySetCookies,
  toCookieHeader,
} = require('./cookie-rotate');

const GENERATE_CONTENT_URL =
  'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent';

const DEFAULT_SAFETY_SETTINGS = [
  [null, null, 7, 5],
  [null, null, 8, 5],
  [null, null, 9, 5],
  [null, null, 10, 5],
];

// Official Google validator bypass token (`btoa("skip_thought_signature_validator")`)
// used when an OpenAI-compatible client replays `assistant.tool_calls` without `thoughtSignature`.
const SKIP_THOUGHT_SIG_VALIDATOR_B64 = Buffer.from(
  'skip_thought_signature_validator',
  'utf8',
).toString('base64');

const FINISH_REASON_MAP = {
  0: 'FINISH_REASON_UNSPECIFIED',
  1: 'STOP',
  2: 'MAX_TOKENS',
  3: 'SAFETY',
  4: 'RECITATION',
  5: 'OTHER',
};

/**
 * AI Studio `ThinkingConfig.thinking_level` (`_.Os.prototype.Xn` / `gGb` in `b0.patched.js`,
 * and `JUg` / `i9e` / `_.Dvf` in `b3.js`):
 *   - 1 = LOW     ("Optimizes for latency")
 *   - 2 = MEDIUM  ("A balanced choice for general purpose use and solid quality")
 *   - 3 = HIGH    ("(Recommended) Maximizes reasoning depth")
 *   - 4 = MINIMAL ("Optimized for fastest response and lowest cost")
 */
const THINKING_LEVEL_MAP = {
  low: 1,
  thinking_level_low: 1,
  medium: 2,
  thinking_level_medium: 2,
  high: 3,
  thinking_level_high: 3,
  minimal: 4,
  thinking_level_minimal: 4,
};

const AISTUDIO_ORIGIN = 'https://aistudio.google.com';
const DEFAULT_GOOGLE_API_KEY = 'AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs';
const PROJECT_ROOT = path.resolve(__dirname, '..');

/** Cookie directory: explicit option > COOKIES_DIR env; otherwise memory-only. */
function resolveCookiesDir(explicitDir) {
  if (explicitDir !== undefined && explicitDir !== null) return path.resolve(explicitDir);
  if (process.env.COOKIES_DIR) return path.resolve(PROJECT_ROOT, process.env.COOKIES_DIR);
  return null;
}

/** Google `SAPISIDHASH` timestamp_digest helper (mirrors waa-runtime auth.js). */
function sapisidHash(sapisid, origin, timestamp = Math.floor(Date.now() / 1000)) {
  const ts = String(timestamp);
  const digest = crypto.createHash('sha1').update(`${ts} ${sapisid} ${origin}`, 'utf8').digest('hex');
  return `${ts}_${digest}`;
}

/**
 * Build the `Authorization` header locally from the caller's own cookies, so a
 * plain mint response only needs to carry `proof` / `poolState`.
 */
function buildAuthorization(cookieMap, origin = AISTUDIO_ORIGIN) {
  const sapisid =
    cookieMap.get('SAPISID') || cookieMap.get('__Secure-3PAPISID') || cookieMap.get('APISID');
  if (!sapisid) return '';
  const ts = Math.floor(Date.now() / 1000);
  const parts = [`SAPISIDHASH ${sapisidHash(sapisid, origin, ts)}`];
  const one = cookieMap.get('__Secure-1PAPISID');
  if (one) parts.push(`SAPISID1PHASH ${sapisidHash(one, origin, ts)}`);
  const three = cookieMap.get('__Secure-3PAPISID');
  if (three && three !== sapisid) parts.push(`SAPISID3PHASH ${sapisidHash(three, origin, ts)}`);
  return parts.join(' ');
}

const SCHEMA_TYPE_MAP = {
  string: 1,
  number: 2,
  integer: 3,
  boolean: 4,
  array: 5,
  object: 6,
};

/**
 * Encode a JS value into `google.protobuf.Value` (`_.bk` in `b0.patched.js`):
 *   - null / undefined -> `[0]`
 *   - number           -> `[null, val]`
 *   - string           -> `[null, null, val]`
 *   - boolean          -> `[null, null, null, val ? 1 : 0]`
 *   - object           -> `[null, null, null, null, encodeProtobufStruct(val)]`
 *   - array            -> `[null, null, null, null, null, [val.map(encodeProtobufValue)]]`
 */
function encodeProtobufValue(val) {
  if (val === null || val === undefined) return [0];
  if (typeof val === 'number') return [null, val];
  if (typeof val === 'string') return [null, null, val];
  if (typeof val === 'boolean') return [null, null, null, val ? 1 : 0];
  if (Array.isArray(val)) {
    return [null, null, null, null, null, [val.map(encodeProtobufValue)]];
  }
  if (typeof val === 'object') {
    return [null, null, null, null, encodeProtobufStruct(val)];
  }
  return [null, null, String(val)];
}

/**
 * Encode a JS plain object into `google.protobuf.Struct` (`_.Yj` in `b0.patched.js`).
 */
function encodeProtobufStruct(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return [[]];
  }
  const entries = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    entries.push([k, encodeProtobufValue(v)]);
  }
  return [entries];
}

/**
 * Decode a `google.protobuf.Value` wire array (`_.bk`) back into a JS value.
 */
function decodeProtobufValue(arr) {
  if (!Array.isArray(arr)) return null;
  if (arr[0] !== null && arr[0] !== undefined) return null;
  if (arr[1] !== null && arr[1] !== undefined) return Number(arr[1]);
  if (arr[2] !== null && arr[2] !== undefined) return String(arr[2]);
  if (arr[3] !== null && arr[3] !== undefined) return Boolean(arr[3]);
  if (Array.isArray(arr[4])) return decodeProtobufStruct(arr[4]);
  if (Array.isArray(arr[5])) {
    return Array.isArray(arr[5][0]) ? arr[5][0].map(decodeProtobufValue) : [];
  }
  return null;
}

/**
 * Decode a `google.protobuf.Struct` wire array (`_.Yj`) back into a JS plain object.
 */
function decodeProtobufStruct(arr) {
  const out = {};
  const entries = Array.isArray(arr) && Array.isArray(arr[0]) ? arr[0] : [];
  for (const pair of entries) {
    if (Array.isArray(pair) && typeof pair[0] === 'string') {
      out[pair[0]] = decodeProtobufValue(pair[1]);
    }
  }
  return out;
}

/**
 * Encode a JSON Schema object into MakerSuite's `Schema` protobuf array (`_.zk` / `_.WK` in `b3.js`).
 */
function encodeSchema(schema) {
  if (!schema || typeof schema !== 'object') return null;
  const rawType = String(schema.type || 'object').toLowerCase();
  const typeCode = SCHEMA_TYPE_MAP[rawType] || 6;

  const wire = [];
  wire[0] = typeCode;
  if (schema.format) wire[1] = String(schema.format);
  if (schema.description) wire[2] = String(schema.description);
  if (typeof schema.nullable === 'boolean') wire[3] = schema.nullable ? 1 : 0;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    wire[4] = schema.enum.map(String);
  }
  if (schema.items && typeof schema.items === 'object') {
    wire[5] = encodeSchema(schema.items);
  }
  if (schema.properties && typeof schema.properties === 'object') {
    const propEntries = [];
    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      if (propSchema && typeof propSchema === 'object') {
        propEntries.push([propName, encodeSchema(propSchema)]);
      }
    }
    wire[6] = propEntries;
  }
  if (Array.isArray(schema.required) && schema.required.length > 0) {
    wire[7] = schema.required.map(String);
  }
  if (schema.minProperties !== undefined) wire[8] = Number(schema.minProperties);
  if (schema.maxProperties !== undefined) wire[9] = Number(schema.maxProperties);
  if (schema.minimum !== undefined) wire[10] = Number(schema.minimum);
  if (schema.maximum !== undefined) wire[11] = Number(schema.maximum);
  if (schema.minLength !== undefined) wire[12] = Number(schema.minLength);
  if (schema.maxLength !== undefined) wire[13] = Number(schema.maxLength);
  if (schema.pattern) wire[14] = String(schema.pattern);
  if (schema.example !== undefined) wire[15] = encodeProtobufValue(schema.example);
  if (Array.isArray(schema.oneOf)) wire[16] = schema.oneOf.map(encodeSchema);
  if (Array.isArray(schema.anyOf)) wire[17] = schema.anyOf.map(encodeSchema);
  if (Array.isArray(schema.allOf)) wire[18] = schema.allOf.map(encodeSchema);
  if (schema.not && typeof schema.not === 'object') wire[19] = encodeSchema(schema.not);
  if (schema.maxItems !== undefined) wire[20] = Number(schema.maxItems);
  if (schema.minItems !== undefined) wire[21] = Number(schema.minItems);
  if (Array.isArray(schema.propertyOrdering)) {
    wire[22] = schema.propertyOrdering.map(String);
  }

  for (let i = 0; i < wire.length; i += 1) {
    if (wire[i] === undefined) wire[i] = null;
  }
  return wire;
}

/**
 * Encode a Gemini `FunctionDeclaration` into MakerSuite's `_.wl` wire array:
 *   `[ name, description, encodedParametersSchema ]`
 */
function encodeFunctionDeclaration(fnDecl) {
  if (!fnDecl || typeof fnDecl !== 'object') return null;
  const name = String(fnDecl.name || '');
  const desc = String(fnDecl.description || '');
  const params = fnDecl.parameters || fnDecl.parametersJsonSchema || fnDecl.parameters_json_schema;
  const wire = [name, desc];
  if (params && typeof params === 'object') {
    wire.push(encodeSchema(params));
  }
  return wire;
}

/**
 * Encode Gemini `tools` or OpenAI `tools` / `functions` array into MakerSuite `wire[6]` (`repeated Tool` `_.wt`).
 */
function encodeToolsWire(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const wireTools = [];
  const openAiFnDecls = [];

  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    if (Array.isArray(t)) {
      wireTools.push(t);
      continue;
    }
    const fnDecls = t.functionDeclarations || t.function_declarations;
    if (Array.isArray(fnDecls) && fnDecls.length > 0) {
      const encodedDecls = fnDecls.map(encodeFunctionDeclaration).filter(Boolean);
      if (encodedDecls.length > 0) {
        wireTools.push([null, encodedDecls]);
      }
      continue;
    }
    if (t.type === 'function' && t.function && typeof t.function === 'object') {
      openAiFnDecls.push(t.function);
      continue;
    }
    if (typeof t.name === 'string') {
      openAiFnDecls.push(t);
      continue;
    }
    if (t.codeExecution || t.code_execution) {
      wireTools.push([[]]);
    }
    if (t.googleSearch || t.google_search) {
      wireTools.push([null, null, null, [null, [[]]]]);
    }
  }

  if (openAiFnDecls.length > 0) {
    const encodedOpenAiDecls = openAiFnDecls.map(encodeFunctionDeclaration).filter(Boolean);
    if (encodedOpenAiDecls.length > 0) {
      wireTools.push([null, encodedOpenAiDecls]);
    }
  }

  return wireTools.length > 0 ? wireTools : null;
}

function extractTextFromPart(part) {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  return '';
}

/**
 * Parse a `data:<mime>;base64,<data>` URL or `{ mimeType, data }` object into
 * a normalized `{ mimeType, data }` object (pure Base64 string without prefix).
 */
function parseBase64Media(input, fallbackMime = 'image/png') {
  if (!input) return null;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    const m = trimmed.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
    if (m) {
      return { mimeType: m[1].trim(), data: m[2].replace(/\s+/g, '') };
    }
    return null;
  }
  if (typeof input === 'object') {
    const rawData = input.data || input.base64 || input.file_data || input.url || '';
    const rawMime = input.mimeType || input.mime_type || fallbackMime;
    if (typeof rawData === 'string' && rawData.length > 0) {
      const m = rawData.trim().match(/^data:([^;,]+);base64,([\s\S]+)$/i);
      if (m) {
        return { mimeType: m[1].trim(), data: m[2].replace(/\s+/g, '') };
      }
      return { mimeType: String(rawMime), data: rawData.replace(/\s+/g, '') };
    }
  }
  return null;
}

/**
 * MakerSuite `Part` Field 3 (`part[2]`, `_.Xs`):
 *   `[null, null, [mimeType, base64Data]]`
 */
function makeInlineDataWirePart(mimeType, base64Data) {
  return [
    null,
    null,
    [String(mimeType || 'application/octet-stream'), String(base64Data || '')],
  ];
}

function makeSignatureWirePart(sigStr, isThought = false) {
  return [
    null,
    '',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    isThought ? 1 : null,
    null,
    String(sigStr),
  ];
}

function makeFunctionCallWirePart(fc, sigStr = null, isThought = false) {
  const fcWire = [
    String(fc.name || ''),
    encodeProtobufStruct(fc.args || {}),
  ];
  if (fc.id) {
    fcWire.push(String(fc.id));
  }
  const part = [
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    fcWire,
  ];
  if (sigStr) {
    part.push(null, isThought ? 1 : null, null, String(sigStr));
  }
  return part;
}

/**
 * Build `functionResponse` (`part[11]`, `_.dt`) and extract any nested local Base64
 * multimodal `inlineData` (from `fr.parts` or `fr.response.inlineData` / `fr.response.parts`)
 * into sibling `[null, null, [mimeType, base64Data]]` parts in the same `user` turn.
 */
function makeFunctionResponseWireParts(fr) {
  const extractedInlineParts = [];

  // 1. Check Gemini 2.5 / 3 Multimodal FunctionResponse `fr.parts`
  if (Array.isArray(fr.parts)) {
    for (const sub of fr.parts) {
      if (!sub || typeof sub !== 'object') continue;
      const inl = sub.inlineData || sub.inline_data;
      const parsed = parseBase64Media(inl);
      if (parsed && parsed.data) {
        extractedInlineParts.push(makeInlineDataWirePart(parsed.mimeType, parsed.data));
      }
    }
  }

  // 2. Check if `fr.response` itself carries `inlineData` / `inline_data` or `parts`
  const rawResp = fr.response;
  let respObj;
  if (rawResp && typeof rawResp === 'object' && !Array.isArray(rawResp)) {
    respObj = { ...rawResp };
    const respInl = respObj.inlineData || respObj.inline_data;
    if (respInl) {
      const parsed = parseBase64Media(respInl);
      if (parsed && parsed.data) {
        extractedInlineParts.push(makeInlineDataWirePart(parsed.mimeType, parsed.data));
        delete respObj.inlineData;
        delete respObj.inline_data;
        if (Object.keys(respObj).length === 0) {
          respObj.status = 'ok (image attached)';
        }
      }
    }
    if (Array.isArray(respObj.parts)) {
      for (const sub of respObj.parts) {
        if (!sub || typeof sub !== 'object') continue;
        const inl = sub.inlineData || sub.inline_data;
        const parsed = parseBase64Media(inl);
        if (parsed && parsed.data) {
          extractedInlineParts.push(makeInlineDataWirePart(parsed.mimeType, parsed.data));
        }
      }
      delete respObj.parts;
      if (Object.keys(respObj).length === 0) {
        respObj.status = 'ok (multimodal parts attached)';
      }
    }
  } else {
    respObj = { response: rawResp };
  }

  const frWire = [
    String(fr.name || ''),
    encodeProtobufStruct(respObj),
  ];
  if (fr.id) {
    frWire.push(String(fr.id));
  }
  const mainFrPart = [
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    frWire,
  ];
  return [mainFrPart, ...extractedInlineParts];
}

/**
 * Build MakerSuite `wire[1]` (`contents`) directly from OpenAI `messages` or Gemini `contents`:
 *   - Top-level `systemInstruction` / `system_instruction` / `system` is converted to
 *     a `role: "user"` turn and prepended at index 0 of `contents`.
 *   - Any interleaved `role: "system"` (or `"developer"`) inside `messages` / `contents`
 *     is converted in-place to `role: "user"` at its original position.
 *   - Supports local Base64 multimodal inputs (`inlineData` in Gemini, `image_url` / `input_audio` / `file` in OpenAI).
 *   - Supports single and parallel `functionCall` parts (`part[10]`) + `thoughtSignature` (`part[14]`)
 *     and single, parallel, and multimodal `functionResponse` parts (`part[11]` + `part[2]`, always role `"user"`).
 */
function buildWireContentsFromPayload(payload = {}) {
  const wireContents = [];

  // 1. Top-level systemInstruction / system_instruction / system -> prepended at index 0 as role="user"
  const topSys = payload.systemInstruction ?? payload.system_instruction ?? payload.system;
  if (topSys) {
    let sysText = '';
    if (typeof topSys === 'string') {
      sysText = topSys.trim();
    } else if (Array.isArray(topSys.parts)) {
      sysText = topSys.parts.map(extractTextFromPart).join('\n').trim();
    } else if (typeof topSys === 'object') {
      sysText = extractTextFromPart(topSys).trim();
    }
    if (sysText) {
      wireContents.push([[[null, sysText]], 'user']);
    }
  }

  // 2. OpenAI `messages` array (supports text + local Base64 `image_url` / `input_audio` / `file` + OpenAI `tool_calls` & `role: "tool"`)
  if (Array.isArray(payload.messages)) {
    const toolCallIdToName = new Map();
    let lastWasToolResponseTurn = false;

    for (const m of payload.messages) {
      if (!m) continue;
      const rawRole = String(m.role || 'user').toLowerCase();

      // 2a. OpenAI `role: "tool"` or `role: "function"` -> MakerSuite `functionResponse` (`part[11]`, role `"user"`)
      // Consecutive `role: "tool"` messages (from parallel tool calls) are merged into a single `"user"` turn.
      if (rawRole === 'tool' || rawRole === 'function') {
        const callId = m.tool_call_id || m.id || null;
        const fnName =
          m.name ||
          m.tool_name ||
          (callId && toolCallIdToName.get(String(callId))) ||
          'tool_response';

        let respPayload = {};
        const inlinePartsForTool = [];
        if (typeof m.content === 'string') {
          const trimmed = m.content.trim();
          if (trimmed) {
            try {
              const parsed = JSON.parse(trimmed);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                respPayload = parsed;
              } else {
                respPayload = { result: parsed };
              }
            } catch {
              respPayload = { result: m.content };
            }
          }
        } else if (Array.isArray(m.content)) {
          const textChunks = [];
          for (const item of m.content) {
            if (!item) continue;
            if (typeof item === 'string') {
              textChunks.push(item);
              continue;
            }
            const itemType = String(item.type || '').toLowerCase();
            if (itemType === 'image_url' || itemType === 'input_image') {
              const urlOrObj = item.image_url ?? item.input_image;
              const media = parseBase64Media(
                typeof urlOrObj === 'string' ? urlOrObj : urlOrObj?.url || urlOrObj,
                'image/png',
              );
              if (media && media.data) {
                inlinePartsForTool.push({ inlineData: media });
              }
              continue;
            }
            const t = extractTextFromPart(item);
            if (t) textChunks.push(t);
          }
          const joined = textChunks.join('\n').trim();
          if (joined) {
            try {
              const parsed = JSON.parse(joined);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                respPayload = parsed;
              } else {
                respPayload = { result: parsed };
              }
            } catch {
              respPayload = { result: joined };
            }
          }
        } else if (m.content && typeof m.content === 'object') {
          respPayload = m.content;
        }

        const frParts = makeFunctionResponseWireParts({
          name: String(fnName),
          ...(callId ? { id: String(callId) } : {}),
          response: respPayload,
          ...(inlinePartsForTool.length > 0 ? { parts: inlinePartsForTool } : {}),
        });

        if (lastWasToolResponseTurn && wireContents.length > 0) {
          wireContents[wireContents.length - 1][0].push(...frParts);
        } else {
          wireContents.push([frParts, 'user']);
          lastWasToolResponseTurn = true;
        }
        continue;
      }

      lastWasToolResponseTurn = false;
      // Convert "system" / "developer" to "user"; "assistant" / "model" to "model"
      const wireRole = rawRole === 'assistant' || rawRole === 'model' ? 'model' : 'user';
      const wireParts = [];

      const rawToolCalls = Array.isArray(m.tool_calls)
        ? m.tool_calls
        : m.function_call && typeof m.function_call === 'object'
          ? [{ id: m.function_call.id, type: 'function', function: m.function_call }]
          : [];
      const hasOpenAiToolCalls = rawToolCalls.length > 0;

      if (typeof m.content === 'string') {
        if (m.content.length > 0 || !hasOpenAiToolCalls) {
          wireParts.push([null, m.content]);
        }
      } else if (Array.isArray(m.content)) {
        for (const item of m.content) {
          if (!item) continue;
          if (typeof item === 'string') {
            wireParts.push([null, item]);
            continue;
          }
          const itemType = String(item.type || '').toLowerCase();
          if (itemType === 'image_url' || itemType === 'input_image') {
            const urlOrObj = item.image_url ?? item.input_image;
            const media = parseBase64Media(
              typeof urlOrObj === 'string' ? urlOrObj : urlOrObj?.url || urlOrObj,
              'image/png',
            );
            if (media && media.data) {
              wireParts.push(makeInlineDataWirePart(media.mimeType, media.data));
            }
            continue;
          }
          if (itemType === 'input_audio' && item.input_audio) {
            const fmt = String(item.input_audio.format || 'mp3').toLowerCase();
            const mime = fmt === 'wav' ? 'audio/wav' : `audio/${fmt}`;
            const media = parseBase64Media(
              { mimeType: mime, data: item.input_audio.data },
              mime,
            );
            if (media && media.data) {
              wireParts.push(makeInlineDataWirePart(media.mimeType, media.data));
            }
            continue;
          }
          if (itemType === 'file' && item.file) {
            const media = parseBase64Media(
              item.file.file_data || item.file,
              item.file.mime_type || 'application/pdf',
            );
            if (media && media.data) {
              wireParts.push(makeInlineDataWirePart(media.mimeType, media.data));
            }
            continue;
          }
          const t = extractTextFromPart(item);
          if (t) {
            wireParts.push([null, t]);
          }
        }
      } else if (m.content && typeof m.content === 'object') {
        const t = extractTextFromPart(m.content);
        if (t) wireParts.push([null, t]);
      }

      if (hasOpenAiToolCalls) {
        const hasMsgLevelSigList =
          Array.isArray(m.thoughtSignatures) && m.thoughtSignatures.length > 0;
        for (let idx = 0; idx < rawToolCalls.length; idx += 1) {
          const tc = rawToolCalls[idx];
          if (!tc || typeof tc !== 'object') continue;
          const fn = tc.function && typeof tc.function === 'object' ? tc.function : tc;
          const fnName = String(fn.name || '');
          const tcId = tc.id ? String(tc.id) : null;
          if (tcId && fnName) {
            toolCallIdToName.set(tcId, fnName);
          }
          let parsedArgs = {};
          const rawArgs = fn.arguments ?? fn.args;
          if (typeof rawArgs === 'string') {
            const trimmedArgs = rawArgs.trim();
            if (trimmedArgs) {
              try {
                const parsed = JSON.parse(trimmedArgs);
                parsedArgs =
                  parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                    ? parsed
                    : { value: parsed };
              } catch {
                parsedArgs = { _raw: rawArgs };
              }
            }
          } else if (rawArgs && typeof rawArgs === 'object') {
            parsedArgs = rawArgs;
          }

          let sigToUse =
            tc.thoughtSignature ||
            tc.thought_signature ||
            (idx === 0 ? m.thoughtSignature || m.thought_signature : null) ||
            null;
          // OpenAI format drops `thoughtSignature`: inject Google's official bypass token on the first functionCall part
          if (!sigToUse && idx === 0 && !hasMsgLevelSigList) {
            sigToUse = SKIP_THOUGHT_SIG_VALIDATOR_B64;
          }

          wireParts.push(
            makeFunctionCallWirePart(
              {
                name: fnName,
                args: parsedArgs,
                ...(tcId ? { id: tcId } : {}),
              },
              sigToUse,
              false,
            ),
          );
        }
      }

      if (wireParts.length === 0 && (!Array.isArray(m.thoughtSignatures) || m.thoughtSignatures.length === 0)) {
        wireParts.push([null, '']);
      }
      if (Array.isArray(m.thoughtSignatures)) {
        for (const s of m.thoughtSignatures) {
          const sigStr = typeof s === 'string' ? s : s && s.signature;
          if (sigStr) wireParts.push(makeSignatureWirePart(sigStr, !!(s && s.thought)));
        }
      }
      wireContents.push([wireParts, wireRole]);
    }
  }

  // 3. Gemini `contents` array (supports text, inlineData, thought, thoughtSignature, single/parallel/multimodal functionCall & functionResponse)
  if (Array.isArray(payload.contents)) {
    for (const c of payload.contents) {
      if (!c) continue;
      // Raw MakerSuite Content tuple `[ wireParts, role ]`
      if (Array.isArray(c) && Array.isArray(c[0])) {
        const rawRole = String(c[1] || 'user').toLowerCase();
        const wireRole = rawRole === 'model' || rawRole === 'assistant' ? 'model' : 'user';
        wireContents.push([c[0], wireRole]);
        continue;
      }

      const rawRole = String(c.role || 'user').toLowerCase();
      // Interleaved "system" / "developer" / "function" / "tool" -> "user"; "model" / "assistant" -> "model"
      let wireRole = rawRole === 'model' || rawRole === 'assistant' ? 'model' : 'user';
      const parts = Array.isArray(c.parts) ? c.parts : [];
      const wireParts = [];
      const trailingSignatures = [];
      let hasFunctionResponse = false;

      for (const p of parts) {
        if (!p) continue;
        // Raw MakerSuite Part array
        if (Array.isArray(p)) {
          wireParts.push(p);
          if (Array.isArray(p[11])) hasFunctionResponse = true;
          continue;
        }

        const sig = p.thoughtSignature || p.thought_signature || null;
        const isThought = !!p.thought;
        const fc = p.functionCall || p.function_call;
        const fr = p.functionResponse || p.function_response;
        const inl = p.inlineData || p.inline_data;

        if (fc && typeof fc === 'object') {
          wireParts.push(makeFunctionCallWirePart(fc, sig, isThought));
          continue;
        }

        if (fr && typeof fr === 'object') {
          hasFunctionResponse = true;
          wireParts.push(...makeFunctionResponseWireParts(fr));
          if (sig) {
            trailingSignatures.push({ signature: sig, thought: isThought });
          }
          continue;
        }

        if (inl && typeof inl === 'object') {
          const media = parseBase64Media(inl);
          if (media && media.data) {
            wireParts.push(makeInlineDataWirePart(media.mimeType, media.data));
          }
          if (sig) {
            trailingSignatures.push({ signature: sig, thought: isThought });
          }
          continue;
        }

        // Plaintext thought summary part from previous turn:
        // Following AI Studio's `_.alb`, omit the previous turn's thought text from wire[1],
        // but preserve any `thoughtSignature` attached to it.
        if (isThought) {
          if (sig) {
            trailingSignatures.push({ signature: sig, thought: true });
          }
          continue;
        }

        const t = extractTextFromPart(p);
        if (t) {
          wireParts.push([null, t]);
          if (sig) {
            trailingSignatures.push({ signature: sig, thought: false });
          }
        } else if (sig) {
          trailingSignatures.push({ signature: sig, thought: false });
        }
      }

      // Append any trailing `thoughtSignature` parts `[null, "", null, ..., "EtIGCs8GA..."]`
      // right at the end of the turn (before the turn closes).
      for (const s of trailingSignatures) {
        wireParts.push(makeSignatureWirePart(s.signature, s.thought));
      }

      if (hasFunctionResponse) {
        wireRole = 'user';
      }

      if (wireParts.length > 0) {
        wireContents.push([wireParts, wireRole]);
      }
    }
  }

  if (typeof payload.prompt === 'string' && wireContents.length === 0) {
    wireContents.push([[[null, payload.prompt]], 'user']);
  }

  if (wireContents.length === 0) {
    wireContents.push([[[null, '']], 'user']);
  }

  return wireContents;
}

function isImageGenerationModel(model) {
  const m = String(model || '').toLowerCase();
  return m.includes('-image') || m.includes('nano-banana') || m.includes('imagen');
}

const MODALITY_MAP = {
  text: 1,
  image: 2,
  audio: 3,
};

/**
 * Build the MakerSuite `GenerationConfig` (`wire[3]`):
 *   - For standard text/reasoning models: enables `thinkingConfig` (`wire[3][16] = [1, budget, null, level]`)
 *     by default so Google returns both the plaintext thinking summary (`part[12] = 1`) and `thoughtSignature` (`part[14]`).
 *   - For image generation models (`gemini-nano-banana-2.1`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`):
 *     sets `wire[3][14] = [1, 2]` (`responseModalities: [TEXT, IMAGE]`) and optional `imageConfig` (`wire[3][26] = [aspectRatio, imageSize]`).
 */
function buildWireGenerationConfig(generationConfig = {}, model = '') {
  const gc = generationConfig && typeof generationConfig === 'object' ? generationConfig : {};
  const maxTokens = gc.maxOutputTokens ?? gc.max_tokens ?? 32768;
  const temp = gc.temperature ?? 1;
  const topP = gc.topP ?? gc.top_p ?? 0.95;
  const topK = gc.topK ?? gc.top_k ?? 64;
  const mime = gc.responseMimeType ?? gc.response_mime_type ?? null;
  const isImgModel = isImageGenerationModel(model);

  let responseModalitiesWire = null;
  const rawModalities = gc.responseModalities || gc.response_modalities;
  if (Array.isArray(rawModalities) && rawModalities.length > 0) {
    const mapped = rawModalities
      .map((m) => (typeof m === 'number' ? m : MODALITY_MAP[String(m).trim().toLowerCase()]))
      .filter(Boolean);
    if (mapped.length > 0) responseModalitiesWire = mapped;
  } else if (isImgModel) {
    responseModalitiesWire = [1, 2];
  }

  const imgCfgInput = gc.imageConfig || gc.image_config || {};
  const aspectRatio =
    imgCfgInput.aspectRatio || imgCfgInput.aspect_ratio || gc.aspectRatio || gc.aspect_ratio || null;
  const imageSize =
    imgCfgInput.imageSize ||
    imgCfgInput.image_size ||
    imgCfgInput.outputResolution ||
    gc.outputResolution ||
    gc.imageSize ||
    null;
  const imageConfigWire =
    aspectRatio || imageSize ? [aspectRatio ? String(aspectRatio) : null, imageSize ? String(imageSize) : null] : null;

  const thinkingCfgInput = gc.thinkingConfig || gc.thinking_config || {};
  const hasExplicitThinking =
    gc.thinkingConfig !== undefined ||
    gc.thinking_config !== undefined ||
    gc.thinkingLevel !== undefined ||
    gc.thinking_level !== undefined ||
    gc.thinkingBudget !== undefined ||
    gc.thinking_budget !== undefined ||
    gc.reasoningEffort !== undefined ||
    gc.reasoning_effort !== undefined;

  const includeThoughts =
    thinkingCfgInput.includeThoughts !== false &&
    thinkingCfgInput.include_thoughts !== false &&
    gc.includeThoughts !== false;

  let thinkingBudget =
    thinkingCfgInput.thinkingBudget ??
    thinkingCfgInput.thinking_budget ??
    gc.thinkingBudget ??
    null;
  if (thinkingBudget !== null && thinkingBudget !== undefined) {
    thinkingBudget = Number(thinkingBudget);
  }

  const suffixMatch = String(model || '').trim().match(/-(high|medium|low|minimal)$/i);
  const forcedLevelStr = suffixMatch ? suffixMatch[1].toLowerCase() : null;

  const rawLevel =
    forcedLevelStr ||
    (thinkingCfgInput.thinkingLevel ??
      thinkingCfgInput.thinking_level ??
      gc.thinkingLevel ??
      gc.thinking_level ??
      gc.reasoningEffort ??
      gc.reasoning_effort ??
      'high');
  const normLevelStr = String(rawLevel).trim().toLowerCase();
  const isDisabled =
    !forcedLevelStr &&
    (!includeThoughts ||
      thinkingBudget === 0 ||
      normLevelStr === 'none' ||
      normLevelStr === 'off' ||
      normLevelStr === 'disabled');
  const thinkingLevel =
    typeof rawLevel === 'number'
      ? rawLevel
      : THINKING_LEVEL_MAP[normLevelStr] || 3;

  const thinkingWire =
    isImgModel && !hasExplicitThinking
      ? null
      : !isDisabled
        ? [1, thinkingBudget, null, thinkingLevel]
        : [null, 0, null, null];

  const wire = [
    null,
    null,
    null,
    maxTokens !== null ? Number(maxTokens) : null,
    temp !== null ? Number(temp) : null,
    topP !== null ? Number(topP) : null,
    topK !== null ? Number(topK) : null,
    mime ? String(mime) : null,
    null,
    null,
    null,
    null,
    null,
    1,
    responseModalitiesWire,
    null,
    thinkingWire,
  ];
  if (imageConfigWire) {
    while (wire.length < 26) wire.push(null);
    wire[26] = imageConfigWire;
  }
  return wire;
}

function buildGenerateWireBody({ model, wireContents, tools, proof, generationConfig }) {
  const normModel = resolveModelAlias(model);
  const genCfg = buildWireGenerationConfig(generationConfig, model || normModel);
  const toolsWire = encodeToolsWire(tools);

  const wire = [
    normModel,
    wireContents,
    DEFAULT_SAFETY_SETTINGS,
    genCfg,
    String(proof), // Field 5 (index 4): WAA `!xxx` proof
  ];
  if (toolsWire) {
    wire[5] = null;
    wire[6] = toolsWire; // Field 7 (index 6): repeated Tool (`_.wt`)
  }
  return JSON.stringify(wire);
}

/**
 * Extract delta text, plaintext thought summary (`part[12]`), `functionCall` (`part[10]`),
 * `thoughtSignature` (`part[14]`), finishReason, and usage from a single MakerSuite frame.
 */
function parseSingleMakerSuiteFrame(frame) {
  let deltaText = '';
  let deltaThought = '';
  const functionCalls = [];
  const inlineImages = [];
  const thoughtSignatures = [];
  const geminiParts = [];
  let finishReasonCode = null;
  let usage = null;

  if (!Array.isArray(frame)) {
    return {
      deltaText,
      deltaThought,
      functionCalls,
      inlineImages,
      thoughtSignatures,
      geminiParts,
      finishReasonCode,
      usage,
    };
  }

  const cands = frame[0];
  if (Array.isArray(cands)) {
    for (const cand of cands) {
      if (!Array.isArray(cand)) continue;
      if (typeof cand[1] === 'number') finishReasonCode = cand[1];
      const content = cand[0];
      const parts = Array.isArray(content) ? content[0] : null;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (!Array.isArray(part)) continue;
          const text = typeof part[1] === 'string' ? part[1] : '';
          const inlWire = Array.isArray(part[2]) ? part[2] : null;
          const fcWire = Array.isArray(part[10]) ? part[10] : null;
          const thoughtFlag = !!part[12];
          const sig = typeof part[14] === 'string' && part[14].length > 0 ? part[14] : null;

          if (inlWire && typeof inlWire[1] === 'string' && inlWire[1].length > 0) {
            const mimeType = String(inlWire[0] || 'image/jpeg');
            const b64Data = String(inlWire[1]);
            const imgPart = {
              inlineData: { mimeType, data: b64Data },
              ...(thoughtFlag ? { thought: true } : {}),
              ...(sig ? { thoughtSignature: sig } : {}),
            };
            inlineImages.push(imgPart);
            geminiParts.push(imgPart);
            if (!thoughtFlag) {
              const mdImg = `![image](data:${mimeType};base64,${b64Data})`;
              deltaText += (deltaText ? '\n\n' : '') + mdImg;
            }
            continue;
          }

          if (fcWire) {
            const fcObj = {
              name: String(fcWire[0] || ''),
              args: decodeProtobufStruct(fcWire[1]),
              ...(fcWire[2] ? { id: String(fcWire[2]) } : {}),
            };
            functionCalls.push({
              functionCall: fcObj,
              ...(sig ? { thoughtSignature: sig } : {}),
              ...(thoughtFlag ? { thought: true } : {}),
            });
            const gPart = { functionCall: fcObj };
            if (thoughtFlag) gPart.thought = true;
            if (sig) gPart.thoughtSignature = sig;
            geminiParts.push(gPart);
            continue;
          }

          if (text) {
            if (thoughtFlag) deltaThought += text;
            else deltaText += text;
          }
          if (sig) {
            thoughtSignatures.push({ signature: sig, thought: thoughtFlag });
          }

          if (text || sig) {
            const gPart = { text };
            if (thoughtFlag) gPart.thought = true;
            if (sig) gPart.thoughtSignature = sig;
            geminiParts.push(gPart);
          }
        }
      }
    }
  }

  const u = frame[2];
  if (Array.isArray(u)) {
    usage = parseUsageMetadata(u);
  }

  return {
    deltaText,
    deltaThought,
    functionCalls,
    inlineImages,
    thoughtSignatures,
    geminiParts,
    finishReasonCode,
    usage,
  };
}

const MODALITY_NAME_MAP = {
  1: 'TEXT',
  2: 'IMAGE',
  3: 'VIDEO',
  4: 'AUDIO',
  5: 'DOCUMENT',
};

function parseModalityTokenDetails(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const out = [];
  for (const item of arr) {
    if (!Array.isArray(item)) continue;
    const modality = MODALITY_NAME_MAP[Number(item[0])] || 'MODALITY_UNSPECIFIED';
    const tokenCount = Number(item[1] ?? 0);
    out.push({ modality, tokenCount });
  }
  return out.length > 0 ? out : null;
}

/**
 * Parse MakerSuite `UsageMetadata` (`_.Kv` = `frame[2]`):
 *   u[0] (field 1):  promptTokenCount
 *   u[1] (field 2):  candidatesTokenCount
 *   u[2] (field 3):  totalTokenCount
 *   u[3] (field 4):  cachedContentTokenCount
 *   u[4] (field 5):  promptTokensDetails      (`repeated ModalityTokenCount` `_.co`)
 *   u[5] (field 6):  cacheTokensDetails       (`repeated ModalityTokenCount` `_.co`)
 *   u[6] (field 7):  candidatesTokensDetails  (`repeated ModalityTokenCount` `_.co`)
 *   u[7] (field 8):  toolUsePromptTokenCount
 *   u[8] (field 9):  toolUsePromptTokensDetails (`repeated ModalityTokenCount` `_.co`)
 *   u[9] (field 10): thoughtsTokenCount
 */
function parseUsageMetadata(u) {
  if (!Array.isArray(u)) return null;
  const promptTokenCount = Number(u[0] ?? 0);
  const candidatesTokenCount = Number(u[1] ?? 0);
  const totalTokenCount = Number(u[2] ?? 0);
  const cachedContentTokenCount = u[3] != null ? Number(u[3]) : null;
  const promptTokensDetails = parseModalityTokenDetails(u[4]);
  const cacheTokensDetails = parseModalityTokenDetails(u[5]);
  const candidatesTokensDetails = parseModalityTokenDetails(u[6]);
  const toolUsePromptTokenCount = u[7] != null ? Number(u[7]) : null;
  const toolUsePromptTokensDetails = parseModalityTokenDetails(u[8]);
  const thoughtsTokenCount = u[9] != null ? Number(u[9]) : null;

  return {
    promptTokenCount,
    candidatesTokenCount,
    totalTokenCount,
    ...(cachedContentTokenCount !== null ? { cachedContentTokenCount } : {}),
    ...(toolUsePromptTokenCount !== null ? { toolUsePromptTokenCount } : {}),
    ...(thoughtsTokenCount !== null ? { thoughtsTokenCount } : {}),
    ...(promptTokensDetails ? { promptTokensDetails } : {}),
    ...(cacheTokensDetails ? { cacheTokensDetails } : {}),
    ...(candidatesTokensDetails ? { candidatesTokensDetails } : {}),
    ...(toolUsePromptTokensDetails ? { toolUsePromptTokensDetails } : {}),
  };
}

function buildGeminiUsageMetadata(usage) {
  const u = usage || { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 };
  const out = {
    promptTokenCount: Number(u.promptTokenCount ?? 0),
    candidatesTokenCount: Number(u.candidatesTokenCount ?? 0),
    totalTokenCount: Number(u.totalTokenCount ?? 0),
  };
  if (u.cachedContentTokenCount != null) out.cachedContentTokenCount = Number(u.cachedContentTokenCount);
  if (u.toolUsePromptTokenCount != null) out.toolUsePromptTokenCount = Number(u.toolUsePromptTokenCount);
  if (u.thoughtsTokenCount != null) out.thoughtsTokenCount = Number(u.thoughtsTokenCount);
  if (Array.isArray(u.promptTokensDetails) && u.promptTokensDetails.length > 0) {
    out.promptTokensDetails = u.promptTokensDetails;
  }
  if (Array.isArray(u.cacheTokensDetails) && u.cacheTokensDetails.length > 0) {
    out.cacheTokensDetails = u.cacheTokensDetails;
  }
  if (Array.isArray(u.candidatesTokensDetails) && u.candidatesTokensDetails.length > 0) {
    out.candidatesTokensDetails = u.candidatesTokensDetails;
  }
  if (Array.isArray(u.toolUsePromptTokensDetails) && u.toolUsePromptTokensDetails.length > 0) {
    out.toolUsePromptTokensDetails = u.toolUsePromptTokensDetails;
  }
  return out;
}

function buildOpenAIUsage(usage) {
  const u = usage || { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 };
  const promptTokens = Number(u.promptTokenCount ?? 0) + Number(u.toolUsePromptTokenCount ?? 0);
  const candidatesTokens = Number(u.candidatesTokenCount ?? 0);
  const reasoningTokens = Number(u.thoughtsTokenCount ?? 0);
  const cachedTokens = Number(u.cachedContentTokenCount ?? 0);
  const completionTokens = candidatesTokens + reasoningTokens;
  const totalTokens = Number(u.totalTokenCount ?? 0) || promptTokens + completionTokens;

  const promptDetails = {
    cached_tokens: cachedTokens,
  };
  if (Array.isArray(u.promptTokensDetails)) {
    for (const item of u.promptTokensDetails) {
      if (!item || !item.modality) continue;
      const key = `${String(item.modality).toLowerCase()}_tokens`;
      promptDetails[key] = (promptDetails[key] || 0) + Number(item.tokenCount ?? 0);
    }
  }
  if (u.toolUsePromptTokenCount != null) {
    promptDetails.tool_use_tokens = Number(u.toolUsePromptTokenCount);
  }

  const completionDetails = {
    reasoning_tokens: reasoningTokens,
  };
  if (Array.isArray(u.candidatesTokensDetails) && u.candidatesTokensDetails.length > 0) {
    for (const item of u.candidatesTokensDetails) {
      if (!item || !item.modality) continue;
      const key = `${String(item.modality).toLowerCase()}_tokens`;
      completionDetails[key] = (completionDetails[key] || 0) + Number(item.tokenCount ?? 0);
    }
  } else {
    completionDetails.text_tokens = candidatesTokens;
  }

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    prompt_tokens_details: promptDetails,
    completion_tokens_details: completionDetails,
  };
}

class IncrementalJspbFrameParser {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buffer = '';
    this.scanIndex = 0;
    this.depth = 0;
    this.inString = false;
    this.escaped = false;
    this.frameStart = -1;
  }

  feed(chunkStr) {
    if (!chunkStr) return;
    this.buffer += chunkStr;

    while (this.scanIndex < this.buffer.length) {
      const ch = this.buffer[this.scanIndex];

      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
        } else if (ch === '\\') {
          this.escaped = true;
        } else if (ch === '"') {
          this.inString = false;
        }
        this.scanIndex += 1;
        continue;
      }

      if (ch === '"') {
        this.inString = true;
      } else if (ch === '[') {
        this.depth += 1;
        if (this.depth === 3) {
          this.frameStart = this.scanIndex;
        }
      } else if (ch === ']') {
        if (this.depth === 3 && this.frameStart !== -1) {
          const frameJson = this.buffer.slice(this.frameStart, this.scanIndex + 1);
          this.depth -= 1;
          this.buffer = this.buffer.slice(this.scanIndex + 1);
          this.scanIndex = 0;
          this.frameStart = -1;
          try {
            const parsedFrame = JSON.parse(frameJson);
            this.onFrame(parsedFrame);
          } catch {}
          continue;
        }
        this.depth -= 1;
      }

      this.scanIndex += 1;
    }
  }
}

const GRPC_STATUS_MAP = {
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  11: 'OUT_OF_RANGE',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  15: 'DATA_LOSS',
  16: 'UNAUTHENTICATED',
};

/** MakerSuite/gRPC 错误体形如 `[,[8,"...message..."]]`（含空位的非严格 JSON），抽出 [code, message]。 */
function extractUpstreamError(rawText) {
  const text = String(rawText == null ? '' : rawText).trim();
  if (!text || text.startsWith('<')) return null;
  let root = null;
  try {
    root = JSON.parse(text);
  } catch {
    root = null;
  }
  if (root !== null) {
    const found = [];
    const scan = (node, depth) => {
      if (!Array.isArray(node) || depth > 3) return;
      if (typeof node[0] === 'number' && typeof node[1] === 'string') {
        found.push([node[0], node[1]]);
        return;
      }
      for (const child of node) scan(child, depth + 1);
    };
    scan(root, 0);
    if (found[0]) return found[0];
  }
  const m = text.match(/\[\s*(\d{1,2})\s*,\s*"((?:[^"\\]|\\.)*)"/);
  if (m) {
    let message = m[2];
    try {
      message = JSON.parse(`"${m[2]}"`);
    } catch {}
    return [Number(m[1]), message];
  }
  return null;
}

function extractUpstreamHtmlMessage(html) {
  const text = String(html || '');
  const pick =
    (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] ||
    (text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] ||
    '';
  const cleaned = pick
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return (
    cleaned ||
    'Google GenerateContent 返回了 HTML 错误页（通常是该模型今日配额已用尽或被边缘风控拦截），请稍后重试或切换其它模型'
  ).slice(0, 240);
}

function parseMakerSuiteResponse(rawText) {
  const text = String(rawText == null ? '' : rawText);
  if (/^\s*<(!doctype|html)/i.test(text)) {
    const snippet = extractUpstreamHtmlMessage(text);
    const htmlErr = new Error(`Google GenerateContent 返回 HTML 错误页：${snippet}`);
    htmlErr.httpStatus = 429;
    htmlErr.upstreamHtml = true;
    htmlErr.officialError = {
      error: { code: 429, message: snippet, status: 'RESOURCE_EXHAUSTED' },
    };
    throw htmlErr;
  }
  const root = JSON.parse(text);
  const frames = Array.isArray(root) && Array.isArray(root[0]) ? root[0] : [];

  let fullText = '';
  let thoughtText = '';
  let rawModelText = '';
  const functionCalls = [];
  const inlineImages = [];
  const thoughtSignatures = [];
  let finishReasonCode = 1;
  let usage = { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 };

  for (const frame of frames) {
    const d = parseSingleMakerSuiteFrame(frame);
    if (d.deltaText) fullText += d.deltaText;
    if (d.deltaThought) thoughtText += d.deltaThought;
    if (d.functionCalls.length > 0) functionCalls.push(...d.functionCalls);
    if (d.inlineImages && d.inlineImages.length > 0) inlineImages.push(...d.inlineImages);
    for (const gp of d.geminiParts || []) {
      if (gp && typeof gp.text === 'string' && !gp.thought && gp.text) {
        rawModelText += gp.text;
      }
    }
    if (d.thoughtSignatures.length > 0) {
      thoughtSignatures.push(...d.thoughtSignatures);
    }
    if (d.finishReasonCode !== null) finishReasonCode = d.finishReasonCode;
    if (d.usage) usage = d.usage;
  }

  return {
    text: fullText,
    rawModelText,
    thought: thoughtText,
    functionCalls,
    inlineImages,
    thoughtSignatures,
    finishReasonCode,
    finishReasonName: FINISH_REASON_MAP[finishReasonCode] || 'STOP',
    usage,
  };
}

/**
 * OpenAI format:
 *   - Plaintext thought summary -> `reasoning_content`
 *   - Answer text -> `content` (`null` when `tool_calls` are present and no text was emitted)
 *   - Function calls -> `tool_calls` (`finish_reason: "tool_calls"`)
 *   - `thoughtSignature` is omitted (auto-bypassed via `skip_thought_signature_validator` on round-trip).
 */
function toOpenAIChatCompletion(parsed, model) {
  const cleanModel = String(model || 'gemini-3.8-flash').replace(/^models\//, '');
  const hasToolCalls = Array.isArray(parsed.functionCalls) && parsed.functionCalls.length > 0;
  const toolCalls = hasToolCalls
    ? parsed.functionCalls.map((item, idx) => {
        const fc = item.functionCall || item;
        return {
          id: fc.id || `call_${crypto.randomBytes(6).toString('hex')}_${idx}`,
          type: 'function',
          function: {
            name: String(fc.name || ''),
            arguments: JSON.stringify(fc.args || {}),
          },
        };
      })
    : null;

  return {
    id: `chatcmpl-${crypto.randomBytes(12).toString('hex')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: cleanModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: hasToolCalls && !parsed.text ? null : parsed.text,
          ...(parsed.thought ? { reasoning_content: parsed.thought } : {}),
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: hasToolCalls
          ? 'tool_calls'
          : parsed.finishReasonCode === 2
            ? 'length'
            : 'stop',
      },
    ],
    usage: buildOpenAIUsage(parsed.usage),
  };
}

/**
 * Gemini format:
 *   - Plaintext thought summary -> `{ text: parsed.thought, thought: true }`
 *   - Answer text -> `{ text: parsed.text }`
 *   - Single or parallel `functionCall` -> `{ functionCall: { name, args, id }, ...(thoughtSignature ? { thoughtSignature } : {}) }`
 *   - Standalone `thoughtSignature` -> `{ text: "", thoughtSignature: "..." }` at the end of `model` parts
 */
function toGeminiResponse(parsed, model) {
  const parts = [];
  const hasImages = Array.isArray(parsed.inlineImages) && parsed.inlineImages.length > 0;
  const textForGemini = hasImages ? parsed.rawModelText || '' : parsed.text || '';
  if (parsed.thought) {
    parts.push({ text: parsed.thought, thought: true });
  }
  if (textForGemini) {
    parts.push({ text: textForGemini });
  }
  if (hasImages) {
    for (const imgPart of parsed.inlineImages) {
      parts.push(imgPart);
    }
  }
  if (Array.isArray(parsed.functionCalls) && parsed.functionCalls.length > 0) {
    for (const fcItem of parsed.functionCalls) {
      parts.push(fcItem);
    }
  }
  if (Array.isArray(parsed.thoughtSignatures)) {
    for (const s of parsed.thoughtSignatures) {
      const sigStr = typeof s === 'string' ? s : s && s.signature;
      if (!sigStr) continue;
      const sigPart = { text: '' };
      if (s && s.thought) sigPart.thought = true;
      sigPart.thoughtSignature = sigStr;
      parts.push(sigPart);
    }
  }
  if (parts.length === 0) {
    parts.push({ text: '' });
  }

  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts,
        },
        finishReason: parsed.finishReasonName,
        index: 0,
      },
    ],
    usageMetadata: buildGeminiUsageMetadata(parsed.usage),
    modelVersion: String(model || 'gemini-3.8-flash').replace(/^models\//, ''),
  };
}

class WaaRelayClient {
  constructor(options = {}) {
    // Configuration comes from `.env` (loaded by bin/start-relay.js); explicit
    // options are only used by programmatic callers / tests.
    this.proofServerUrl = String(
      options.proofServerUrl || process.env.PROOF_SERVER_URL || 'http://127.0.0.1:18801',
    ).replace(/\/+$/, '');
    this.origin = String(options.origin || AISTUDIO_ORIGIN).replace(/\/+$/, '');
    this.googleApiKey =
      options.googleApiKey || process.env.GOOGLE_API_KEY || DEFAULT_GOOGLE_API_KEY;
    this.generateContentUrl = options.generateContentUrl || GENERATE_CONTENT_URL;
    this.defaultCookies = options.cookies || '';
    this.defaultAuthUser = Number(options.authUser ?? 0);
    this.defaultModel = resolveModelAlias(
      options.defaultModel || process.env.DEFAULT_MODEL || 'gemini-3.8-flash',
    );
    this.accountStore =
      options.accountStore ||
      new RelayAccountStore({ storageDir: resolveCookiesDir(options.cookiesDir) });
    if (this.defaultCookies) {
      try {
        this.accountStore.addAccount(this.defaultCookies, this.defaultAuthUser, null, 'startup');
      } catch {}
    }
    this.userAgent =
      options.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
  }

  async requestProof({ cookies, authUser, g1Tier, model, wireContents, generationConfig, forceRefresh }) {
    const min = extractMinimalCookies(cookies || this.defaultCookies);
    if (min.map.size === 0) {
      throw new Error('No valid Google cookies provided to Relay Client');
    }
    const res = await globalThis.fetch(`${this.proofServerUrl}/v1/proof/mint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cookies: min.header,
        authUser: authUser ?? this.defaultAuthUser,
        g1Tier,
        model: model || this.defaultModel,
        wireContents,
        generationConfig,
        ...(forceRefresh ? { forceRefresh: true } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(`Proof Server error (${res.status}): ${data.error || 'unknown'}`);
    }
    return data;
  }

  /** Persist refreshed cookies back into the account store (memory + cookies/*.json). */
  updateStoredCookies(rawCookies, authUser, newHeader) {
    if (!this.accountStore || typeof this.accountStore.updateCookies !== 'function') return;
    try {
      this.accountStore.updateCookies(rawCookies, authUser, newHeader);
    } catch (err) {
      console.warn(`[relay] 回写 Cookie 失败: ${err.message}`);
    }
  }

  /**
   * Rotate the account cookies locally (accounts.google.com/RotateCookies).
   * Returns the refreshed cookie header, or null when rotation was skipped/failed.
   */
  async rotateAccountCookies(rawCookies, authUser) {
    const min = extractMinimalCookies(rawCookies || '');
    if (min.map.size === 0) return null;
    const store = this.accountStore;
    const result = await rotateGoogleCookies(min.map, { userAgent: this.userAgent });
    if (result.ok) {
      const header = toCookieHeader(min.map);
      this.updateStoredCookies(rawCookies, authUser, header);
      if (result.updated && result.updated.length > 0) {
        return header;
      }
    }
    const anchor = computeSessionAnchor(min.map);
    if (anchor && store && store.accounts) {
      const origHeader = toCookieHeader(extractMinimalCookies(rawCookies || '').map);
      const siblings = [];
      for (const sib of store.accounts.values()) {
        if (!sib || !sib.cookies) continue;
        const sibMin = extractMinimalCookies(sib.cookies);
        if (computeSessionAnchor(sibMin.map) !== anchor) continue;
        if (toCookieHeader(sibMin.map) === origHeader) continue;
        siblings.push({ sib, sibMin });
      }
      siblings.sort((a, b) => {
        const aHasTs = a.sibMin.map.has('__Secure-1PSIDTS') || a.sibMin.map.has('__Secure-3PSIDTS') ? 1 : 0;
        const bHasTs = b.sibMin.map.has('__Secure-1PSIDTS') || b.sibMin.map.has('__Secure-3PSIDTS') ? 1 : 0;
        if (bHasTs !== aHasTs) return bHasTs - aHasTs;
        return (Number(b.sib.updatedAt) || 0) - (Number(a.sib.updatedAt) || 0);
      });
      for (const { sibMin } of siblings) {
        const sibMap = new Map([...min.map, ...sibMin.map]);
        const sibResult = await rotateGoogleCookies(sibMap, { userAgent: this.userAgent });
        if (sibResult.ok) {
          const header = toCookieHeader(sibMap);
          this.updateStoredCookies(rawCookies, authUser, header);
          return header;
        }
      }
    }
    return null;
  }

  async openGenerateStream(params, retryState = null) {
    const {
      payload,
      wireContents,
      tools,
      model,
      generationConfig,
      cookies,
      authUser,
      g1Tier,
      accountId,
      fromStore,
    } = params;
    const resolvedWireContents = wireContents || buildWireContentsFromPayload(payload || {});
    const targetModel = resolveModelAlias(model || this.defaultModel);

    // Failover state for this request: at most min(ready accounts, 3) distinct
    // accounts, never the same account twice (plus one cookie-rotation retry).
    const state =
      retryState || {
        tried: new Set(accountId ? [accountId] : []),
        rotatedAccounts: new Set(),
        retry403Counts: new Map(),
        retryHtmlCounts: new Map(),
        fromStore: !!fromStore,
        maxAttempts: fromStore && accountId ? Math.min(this.accountStore.countReady(), 3) : 1,
      };

    const proofPkg = await this.requestProof({
      cookies,
      authUser,
      g1Tier,
      model: targetModel,
      wireContents: resolvedWireContents,
      generationConfig,
      forceRefresh: Boolean(params.forceRefresh),
    });

    // The signer only returns the proof: cookies + Authorization stay local.
    // (Cookie rotation is also a relay-side concern, see rotateAccountCookies.)
    const minimal = extractMinimalCookies(cookies || this.defaultCookies);
    const auth = {
      cookies: minimal.header,
      rpcCookies: toCookieHeader(minimal.map, { includeAccountHost: false }),
      authorization: buildAuthorization(minimal.map, this.origin),
      googleApiKey: this.googleApiKey,
      authUser: authUser ?? this.defaultAuthUser,
      g1Tier: g1Tier || 'TIER0',
      origin: this.origin,
    };

    const wireBody = buildGenerateWireBody({
      model: targetModel,
      wireContents: resolvedWireContents,
      tools,
      proof: proofPkg.proof,
      generationConfig,
    });

    const detectedTier =
      proofPkg && (proofPkg.g1Tier === 'TIER1' || proofPkg.g1Tier === 'TIER2')
        ? proofPkg.g1Tier
        : null;
    const resolvedTier = detectedTier || g1Tier || auth.g1Tier || 'TIER0';
    if (detectedTier && this.accountStore && this.accountStore.accounts) {
      const targetId =
        accountId ||
        (minimal.map.size > 0 ? computeAccountId(minimal.map, auth.authUser ?? 0) : null);
      const storedEntry = targetId ? this.accountStore.accounts.get(targetId) : null;
      if (storedEntry && storedEntry.g1Tier !== detectedTier) {
        storedEntry.g1Tier = detectedTier;
        if (this.accountStore.cookieStore && typeof this.accountStore.cookieStore.save === 'function') {
          try {
            this.accountStore.cookieStore.save(storedEntry);
          } catch {}
        }
      }
    }
    const reqHeaders = {
      'content-type': 'application/json+protobuf',
      'x-user-agent': 'grpc-web-javascript/0.1',
      'x-goog-api-key': auth.googleApiKey,
      'x-goog-authuser': String(auth.authUser ?? 0),
      'x-goog-ext-519733851-bin': 'CAASAUIwATgEQABQBFgDYgJKUHAAeAGQAQCYAQE=',
      authorization: auth.authorization,
      cookie: auth.rpcCookies || auth.cookies,
      origin: auth.origin || this.origin,
      referer: (auth.origin || this.origin) + '/',
      'user-agent': this.userAgent,
    };
    if (resolvedTier === 'TIER1' || resolvedTier === 'TIER2') {
      reqHeaders['x-aistudio-g1-tier'] = resolvedTier;
    }

    const tRpc0 = Date.now();
    let res;
    try {
      res = await globalThis.fetch(this.generateContentUrl, {
        method: 'POST',
        headers: reqHeaders,
        body: wireBody,
      });
    } catch (err) {
      // Network failure is retryable on the next account.
      const switched = this.retryWithNextAccount(state, params, resolvedWireContents, targetModel);
      if (switched) return switched;
      const netErr = new Error(`Google GenerateContent network error: ${err.message}`);
      netErr.httpStatus = 502;
      throw netErr;
    }

    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (setCookies.length > 0) {
      // Apply Google's cookie rotation to our own (authoritative) copy.
      const map = new Map(minimal.map);
      if (applySetCookies(map, setCookies).length > 0) {
        auth.cookies = toCookieHeader(map);
        this.updateStoredCookies(cookies, authUser, auth.cookies);
      }
    }

    const upstreamContentType = String(res.headers.get('content-type') || '').toLowerCase();
    const looksHtml =
      upstreamContentType.includes('text/html') || upstreamContentType.includes('application/xhtml');
    if (looksHtml) {
      // Google 在额度耗尽 / 边缘风控时可能用 HTTP 200 返回 HTML 拦截页。
      // 直接交给 JSON.parse 会报 "Unexpected JSON token ... <!DOCTYPE html>"，这里统一转成官方错误 JSON。
      let htmlText = '';
      try {
        htmlText = await res.text();
      } catch {}
      const snippet = extractUpstreamHtmlMessage(htmlText);
      const htmlKey = accountId || 'default';
      const countHtml = (state.retryHtmlCounts && state.retryHtmlCounts.get(htmlKey)) || 0;
      if (countHtml < 2) {
        state.retryHtmlCounts.set(htmlKey, countHtml + 1);
        return this.openGenerateStream(
          {
            ...params,
            wireContents: resolvedWireContents,
            model: targetModel,
            cookies: auth.cookies,
            g1Tier: resolvedTier,
          },
          state,
        );
      }
      const htmlErr = new Error(
        `Google GenerateContent 返回 HTML 错误页（HTTP ${res.status}）：${snippet}`,
      );
      htmlErr.httpStatus = 429;
      htmlErr.upstreamHtml = true;
      htmlErr.officialError = {
        error: {
          code: 429,
          message: snippet,
          status: 'RESOURCE_EXHAUSTED',
        },
      };
      throw htmlErr;
    }

    if (!res.ok) {
      const rawText = await res.text();
      const regionBlocked = res.status === 403 && rawText.includes('Region not supported');
      // 401 / permission-403 / 429 / 5xx are retryable on another account.
      const isRetryable =
        !regionBlocked &&
        (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500);

      if (isRetryable) {
        // Only rotate cookies on 401 (never on 403 permission errors, which
        // would trigger Google's high-frequency RotateCookies rate limit).
        // When rotation succeeds, immediately retry the CURRENT account in-place
        // with the freshly rotated cookies BEFORE failing over to the next account!
        const rotateKey = accountId || 'default';
        if (res.status === 401 && !state.rotatedAccounts.has(rotateKey)) {
          state.rotatedAccounts.add(rotateKey);
          const rotated = await this.rotateAccountCookies(auth.cookies, auth.authUser);
          if (rotated) {
            return this.openGenerateStream(
              {
                ...params,
                wireContents: resolvedWireContents,
                model: targetModel,
                cookies: rotated,
              },
              state,
            );
          }
        }

        if (res.status === 403) {
          if (!state.rotatedAccounts.has(rotateKey)) {
            state.rotatedAccounts.add(rotateKey);
            const rotated = await this.rotateAccountCookies(auth.cookies, auth.authUser);
            if (rotated) {
              return this.openGenerateStream(
                {
                  ...params,
                  wireContents: resolvedWireContents,
                  model: targetModel,
                  cookies: rotated,
                  g1Tier: resolvedTier,
                  forceRefresh: true,
                },
                state,
              );
            }
          }
          const count403 = (state.retry403Counts && state.retry403Counts.get(rotateKey)) || 0;
          if (count403 < 2) {
            state.retry403Counts.set(rotateKey, count403 + 1);
            return this.openGenerateStream(
              {
                ...params,
                wireContents: resolvedWireContents,
                model: targetModel,
                cookies: auth.cookies,
                g1Tier: resolvedTier,
                forceRefresh: true,
              },
              state,
            );
          }
        }

        const switched = this.retryWithNextAccount(state, params, resolvedWireContents, targetModel);
        if (switched) return switched;
      }

      const upstreamErr = extractUpstreamError(rawText);
      const message = upstreamErr
        ? upstreamErr[1]
        : rawText.replace(/^\s*/, '').slice(0, 240);
      const err = new Error(`Google GenerateContent HTTP ${res.status}: ${message}`);
      err.httpStatus = res.status;
      err.officialError = {
        error: {
          code: res.status,
          message,
          status:
            GRPC_STATUS_MAP[upstreamErr && upstreamErr[0]] ||
            (res.status === 429
              ? 'RESOURCE_EXHAUSTED'
              : res.status === 403
                ? 'PERMISSION_DENIED'
                : res.status === 401
                  ? 'UNAUTHENTICATED'
                  : res.status >= 500
                    ? 'INTERNAL'
                    : 'UNKNOWN'),
        },
      };
      throw err;
    }

    const usedAccountId =
      accountId ||
      (minimal.map.size > 0 ? computeAccountId(minimal.map, auth.authUser ?? 0) : null);
    if (this.accountStore && usedAccountId && typeof this.accountStore.recordModelUsage === 'function') {
      this.accountStore.recordModelUsage(usedAccountId, targetModel);
    }

    return { res, proofPkg, targetModel, tRpc0 };
  }

  /**
   * Failover helper: switch to the next untried pool account.
   * Returns the retry promise, or null when no other account may be tried.
   */
  retryWithNextAccount(state, params, wireContents, targetModel) {
    if (!state.fromStore || state.tried.size >= state.maxAttempts) return null;
    const next = this.accountStore.pickAccountExcluding(state.tried);
    if (!next) return null;
    state.tried.add(next.accountId);
    return this.openGenerateStream(
      {
        wireContents,
        tools: params.tools,
        model: targetModel,
        generationConfig: params.generationConfig,
        cookies: next.cookies,
        authUser: next.authUser,
        g1Tier: next.g1Tier,
        accountId: next.accountId,
        fromStore: true,
      },
      state,
    );
  }

  async callGenerateContent(params) {
    const { res, proofPkg, targetModel, tRpc0 } = await this.openGenerateStream(params);
    const rawText = await res.text();
    const rpcMs = Date.now() - tRpc0;
    const parsed = parseMakerSuiteResponse(rawText);
    return {
      parsed,
      proof: proofPkg.proof,
      proofLength: proofPkg.proofLength,
      proofMode: proofPkg.proofMode,
      digest: proofPkg.digest,
      accountId: proofPkg.accountId,
      poolState: proofPkg.poolState,
      timingMs: {
        ...proofPkg.timingMs,
        generateRpc: rpcMs,
      },
      model: targetModel,
    };
  }

  async streamGenerateContent(params, onDelta) {
    const { res, proofPkg, targetModel, tRpc0 } = await this.openGenerateStream(params);
    const parser = new IncrementalJspbFrameParser((frame) => {
      const delta = parseSingleMakerSuiteFrame(frame);
      onDelta({ ...delta, frame });
    });

    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunkStr = decoder.decode(value, { stream: true });
        parser.feed(chunkStr);
      }
      const tail = decoder.decode();
      if (tail) parser.feed(tail);
    } else {
      const rawText = await res.text();
      parser.feed(rawText);
    }

    return {
      proofPkg,
      model: targetModel,
      rpcMs: Date.now() - tRpc0,
    };
  }

  async chatCompletions(openAiBody = {}, authOverrides = {}) {
    const wireContents = buildWireContentsFromPayload(openAiBody);
    const extraBody =
      openAiBody.extra_body && typeof openAiBody.extra_body === 'object'
        ? openAiBody.extra_body
        : {};
    const generationConfig = {
      ...(openAiBody.generationConfig || openAiBody.generation_config || {}),
      temperature: openAiBody.temperature,
      topP: openAiBody.top_p,
      maxOutputTokens: openAiBody.max_tokens ?? openAiBody.max_completion_tokens,
      reasoningEffort:
        openAiBody.reasoning_effort ??
        openAiBody.reasoningEffort ??
        (openAiBody.reasoning && openAiBody.reasoning.effort) ??
        extraBody.reasoning_effort,
      thinkingConfig:
        openAiBody.thinking_config ||
        openAiBody.thinkingConfig ||
        extraBody.thinking_config ||
        (extraBody.google && extraBody.google.thinking_config),
    };
    const tools = openAiBody.tools || openAiBody.functions || null;
    const res = await this.callGenerateContent({
      wireContents,
      tools,
      model: openAiBody.model || this.defaultModel,
      generationConfig,
      cookies: authOverrides.cookies || openAiBody.cookies || this.defaultCookies,
      authUser: authOverrides.authUser ?? openAiBody.authUser ?? this.defaultAuthUser,
      g1Tier: authOverrides.g1Tier,
      accountId: authOverrides.accountId || null,
      fromStore: !!authOverrides.fromStore,
    });
    return {
      response: toOpenAIChatCompletion(res.parsed, res.model),
      meta: {
        proof: res.proof,
        proofLength: res.proofLength,
        proofMode: res.proofMode,
        digest: res.digest,
        accountId: res.accountId,
        poolState: res.poolState,
        timingMs: res.timingMs,
      },
    };
  }

  async geminiGenerateContent(geminiBody = {}, model, authOverrides = {}) {
    const wireContents = buildWireContentsFromPayload(geminiBody);
    const generationConfig = {
      ...(geminiBody.generationConfig || geminiBody.generation_config || {}),
      ...(geminiBody.thinkingConfig || geminiBody.thinking_config
        ? { thinkingConfig: geminiBody.thinkingConfig || geminiBody.thinking_config }
        : {}),
      ...(geminiBody.reasoning_effort || geminiBody.reasoningEffort
        ? { reasoningEffort: geminiBody.reasoning_effort || geminiBody.reasoningEffort }
        : {}),
    };
    const tools = geminiBody.tools || null;
    const res = await this.callGenerateContent({
      wireContents,
      tools,
      model: model || geminiBody.model || this.defaultModel,
      generationConfig,
      cookies: authOverrides.cookies || geminiBody.cookies || this.defaultCookies,
      authUser: authOverrides.authUser ?? geminiBody.authUser ?? this.defaultAuthUser,
      g1Tier: authOverrides.g1Tier,
      accountId: authOverrides.accountId || null,
      fromStore: !!authOverrides.fromStore,
    });
    return {
      response: toGeminiResponse(res.parsed, res.model),
      meta: {
        proof: res.proof,
        proofLength: res.proofLength,
        proofMode: res.proofMode,
        digest: res.digest,
        accountId: res.accountId,
        poolState: res.poolState,
        timingMs: res.timingMs,
      },
    };
  }
}

function readJsonBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`Invalid JSON body: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  // SSE 已经发过响应头时不能再 writeHead（否则抛 ERR_HTTP_HEADERS_SENT 直接崩进程）。
  // 此时降级为一条 SSE 错误帧 + [DONE]，让客户端仍能拿到结构化错误。
  if (res.headersSent || res.writableEnded) {
    if (!res.writableEnded) {
      try {
        res.write(`data: ${body}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } catch {}
    }
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

/**
 * Build optional proof metadata headers.
 *
 * The proof server response is intentionally minimal
 * (`ok` / `proof` / `poolState` / `auth`), so every field here is guarded —
 * missing fields simply omit the header instead of emitting `undefined`.
 */
function proofMetaHeaders(meta = {}) {
  const headers = {};
  if (meta.accountId) headers['X-WAA-Account-Id'] = meta.accountId;
  if (meta.poolState) headers['X-WAA-Pool-State'] = meta.poolState;
  if (meta.proofLength !== undefined && meta.proofLength !== null) {
    headers['X-WAA-Proof-Length'] = String(meta.proofLength);
  }
  if (meta.timingMs && meta.timingMs.mint !== undefined && meta.timingMs.mint !== null) {
    headers['X-WAA-Mint-Ms'] = String(meta.timingMs.mint);
  }
  return headers;
}

function applyProofMetaHeaders(res, meta) {
  for (const [name, value] of Object.entries(proofMetaHeaders(meta))) {
    res.setHeader(name, value);
  }
}

/**
 * Ask the proof server what it knows about one account (state / mints / expiry).
 * The proof server requires the account cookies, so the caller supplies them.
 */
async function fetchAccountPoolInfo(relayClient, entry) {
  try {
    const url = `${relayClient.proofServerUrl}/v1/pool/stats?authUser=${encodeURIComponent(
      entry.authUser ?? 0,
    )}`;
    const res = await globalThis.fetch(url, {
      headers: { 'X-Google-Cookies': entry.cookies },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.account ? data.account : null;
  } catch {
    return null;
  }
}

function computeSessionToken(apiKey) {
  return crypto
    .createHmac('sha256', `waa-relay-session:${apiKey}`)
    .update('panel-auth-v1')
    .digest('hex');
}

function parseHttpCookies(req) {
  const raw = String(req.headers.cookie || '');
  const out = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) {
        try {
          out[k] = decodeURIComponent(v);
        } catch {
          out[k] = v;
        }
      }
    }
  }
  return out;
}

function extractProvidedApiKey(req, url) {
  const authHeader = String(req.headers.authorization || '').trim();
  const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
  const xApiKey = String(req.headers['x-api-key'] || '').trim();
  const xGoogKey = String(req.headers['x-goog-api-key'] || '').trim();
  const queryKey = url && url.searchParams ? String(url.searchParams.get('key') || '').trim() : '';
  return bearer || xApiKey || xGoogKey || queryKey;
}

function isPanelAuthenticated(req, url, expectedApiKey) {
  if (!expectedApiKey) return true;
  const cookies = parseHttpCookies(req);
  if (cookies.waa_relay_session && cookies.waa_relay_session === computeSessionToken(expectedApiKey)) {
    return true;
  }
  const providedKey = extractProvidedApiKey(req, url);
  if (providedKey && providedKey === expectedApiKey) {
    return true;
  }
  return false;
}

function extractRequestAuth(req, body, relayClient, expectedApiKey, url = null) {
  let cookies = req.headers['x-google-cookies'] || body.cookies || '';
  let authUser = req.headers['x-goog-authuser'] ?? body.authUser;
  let g1Tier = req.headers['x-aistudio-g1-tier'] || body.g1Tier || null;
  let accountId = null;
  let fromStore = false;

  const providedToken = extractProvidedApiKey(req, url);

  if (!cookies && providedToken && (providedToken.includes('SID=') || providedToken.includes('SAPISID='))) {
    cookies = providedToken;
  } else if (expectedApiKey && providedToken && providedToken !== expectedApiKey) {
    const err = new Error('Invalid API Key');
    err.httpStatus = 401;
    throw err;
  }

  if (!cookies && relayClient.accountStore) {
    const picked = relayClient.accountStore.pickAccount();
    if (picked) {
      cookies = picked.cookies;
      accountId = picked.accountId;
      fromStore = true;
      if (authUser === undefined || authUser === null) {
        authUser = picked.authUser;
      }
      if (!g1Tier && picked.g1Tier) {
        g1Tier = picked.g1Tier;
      }
    }
  }

  return { cookies, authUser, g1Tier, accountId, fromStore };
}

function createRelayServer(options = {}) {
  const relayClient = options.client || new WaaRelayClient(options);
  const host = options.host || process.env.RELAY_HOST || '127.0.0.1';
  const port = Number(options.port ?? process.env.RELAY_PORT ?? 18802);
  const apiKey = options.apiKey || process.env.RELAY_API_KEY || 'sk-waa-local-relay-key';

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      return res.end();
    }

    const reqHost = req.headers.host || `${host}:${port}`;
    const url = new URL(req.url || '/', `http://${reqHost}`);
    const pathname = url.pathname;

    try {
      if (req.method === 'GET' && pathname === '/') {
        if (!isPanelAuthenticated(req, url, apiKey)) {
          const html = renderLoginHtml();
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(html);
        }
        const html = renderDashboardHtml({ apiKey, defaultModel: relayClient.defaultModel });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      if (req.method === 'POST' && pathname === '/api/login') {
        const body = await readJsonBody(req);
        const inputKey = String(body.apiKey || body.password || '').trim();
        if (apiKey && inputKey !== apiKey) {
          return sendJson(res, 401, { ok: false, error: 'API Key 错误' });
        }
        const token = computeSessionToken(apiKey);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': `waa_relay_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        });
        return res.end(JSON.stringify({ ok: true }));
      }

      if ((req.method === 'GET' && pathname === '/logout') || (req.method === 'POST' && pathname === '/api/logout')) {
        const clearCookie = 'waa_relay_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
        if (req.method === 'GET') {
          res.writeHead(302, { Location: '/', 'Set-Cookie': clearCookie });
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': clearCookie });
        return res.end(JSON.stringify({ ok: true }));
      }

      if (req.method === 'GET' && pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          service: 'waa-relay-client-gateway',
          proofServerUrl: relayClient.proofServerUrl,
          accountCount: relayClient.accountStore.accounts.size,
          cookiesDir: relayClient.accountStore.storageDir || null,
        });
      }

      if (req.method === 'GET' && pathname === '/api/status') {
        if (!isPanelAuthenticated(req, url, apiKey)) {
          return sendJson(res, 401, { ok: false, error: 'Unauthorized: 请先使用 API Key 登录面板' });
        }
        const store = relayClient.accountStore;
        const accounts = store.listPublic();
        const poolByAccount = {};
        await Promise.all(
          Array.from(store.accounts.values())
            .filter((entry) => entry.status === 'ready')
            .map(async (entry) => {
              poolByAccount[entry.accountId] = await fetchAccountPoolInfo(relayClient, entry);
            }),
        );
        return sendJson(res, 200, {
          ok: true,
          model: relayClient.defaultModel,
          accountCount: accounts.length,
          accounts: accounts.map((a) => ({ ...a, pool: poolByAccount[a.accountId] || null })),
          cookiesDir: store.storageDir || null,
          cookieFiles: store.cookieStore ? store.cookieStore.count() : 0,
        });
      }

      if (req.method === 'POST' && (pathname === '/api/accounts/add' || pathname === '/v1/accounts/add')) {
        if (!isPanelAuthenticated(req, url, apiKey)) {
          return sendJson(res, 401, { ok: false, error: 'Unauthorized: 请先使用 API Key 登录面板' });
        }
        const body = await readJsonBody(req);
        const pubAcc = relayClient.accountStore.addAccount(
          body.cookies || body,
          body.authUser ?? 0,
          body.g1Tier || null,
          'manual',
        );
        return sendJson(res, 200, { ok: true, account: pubAcc });
      }

      if (req.method === 'POST' && pathname === '/api/accounts/remove') {
        if (!isPanelAuthenticated(req, url, apiKey)) {
          return sendJson(res, 401, { ok: false, error: 'Unauthorized: 请先使用 API Key 登录面板' });
        }
        const body = await readJsonBody(req);
        relayClient.accountStore.removeAccount(body.accountId);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && (pathname === '/api/accounts/test' || pathname === '/v1/accounts/test')) {
        if (!isPanelAuthenticated(req, url, apiKey)) {
          return sendJson(res, 401, { ok: false, error: 'Unauthorized: 请先使用 API Key 登录面板' });
        }
        const body = await readJsonBody(req);
        const entry = relayClient.accountStore.accounts.get(body.accountId);
        if (!entry) {
          return sendJson(res, 404, { ok: false, alive: false, error: '未找到该账号' });
        }
        const t0 = Date.now();
        const probeNum = (t0 % 89) + 10;
        try {
          const testRes = await relayClient.callGenerateContent({
            wireContents: [[[[null, `${probeNum}+1=`]], 'user']],
            model: 'models/gemini-3.5-flash-lite',
            generationConfig: {
              maxOutputTokens: 64,
              thinkingLevel: 'minimal',
            },
            cookies: entry.cookies,
            authUser: entry.authUser,
            g1Tier: entry.g1Tier,
            accountId: entry.accountId,
            fromStore: false,
          });
          entry.status = 'ready';
          entry.lastError = null;
          if (relayClient.accountStore.cookieStore && typeof relayClient.accountStore.cookieStore.save === 'function') {
            try {
              relayClient.accountStore.cookieStore.save(entry);
            } catch {}
          }
          return sendJson(res, 200, {
            ok: true,
            alive: true,
            model: 'gemini-3.5-flash-lite',
            elapsedMs: Date.now() - t0,
            reply: (testRes.parsed.text || '').trim().slice(0, 60),
          });
        } catch (err) {
          const msg = String((err && err.message) || '');
          const isQuota429 =
            (err && err.httpStatus === 429) ||
            msg.includes('HTTP 429') ||
            msg.includes('Quota exceeded') ||
            msg.includes('usage limit');
          if (isQuota429) {
            entry.status = 'ready';
            entry.lastError = null;
            if (relayClient.accountStore.cookieStore && typeof relayClient.accountStore.cookieStore.save === 'function') {
              try {
                relayClient.accountStore.cookieStore.save(entry);
              } catch {}
            }
            return sendJson(res, 200, {
              ok: true,
              alive: true,
              quota429: true,
              model: 'gemini-3.5-flash-lite',
              elapsedMs: Date.now() - t0,
              reply: '凭证有效（当前模型今日配额已满）',
            });
          }
          entry.lastError = msg;
          return sendJson(res, 200, {
            ok: true,
            alive: false,
            model: 'gemini-3.5-flash-lite',
            elapsedMs: Date.now() - t0,
            error: msg,
          });
        }
      }

      const SUPPORTED_MODELS = [
        { id: 'gemini-4-argon', displayName: 'Gemini 4 Argon' },
        { id: 'gemini-4-argon-high', displayName: 'Gemini 4 Argon (High Thinking)' },
        { id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' },
        { id: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High Thinking)' },
        { id: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash' },
        { id: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash Lite' },
        { id: 'gemini-3.5-flash-lite-high', displayName: 'Gemini 3.5 Flash Lite (High Thinking)' },
        { id: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview' },
        { id: 'gemini-3.1-pro-preview-high', displayName: 'Gemini 3.1 Pro Preview (High Thinking)' },
        { id: 'gemini-nano-banana-2.1', displayName: 'Nano Banana 2.1' },
        { id: 'gemini-3.1-flash-image', displayName: 'Nano Banana 2 (Gemini 3.1 Flash Image)' },
        { id: 'gemini-3.1-flash-lite-image', displayName: 'Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image)' },
        { id: 'gemini-3-pro-image', displayName: 'Nano Banana Pro (Gemini 3 Pro Image)' },
      ];

      if (req.method === 'GET' && pathname === '/v1/models') {
        return sendJson(res, 200, {
          object: 'list',
          data: SUPPORTED_MODELS.map((m) => ({
            id: m.id,
            object: 'model',
            owned_by: 'google-aistudio',
          })),
        });
      }

      if (req.method === 'GET' && (pathname === '/v1beta/models' || pathname === '/models')) {
        return sendJson(res, 200, {
          models: SUPPORTED_MODELS.map((m) => ({
            name: `models/${m.id}`,
            version: '001',
            displayName: m.displayName,
            description: `${m.displayName} via AI Studio Playground`,
            inputTokenLimit: 1048576,
            outputTokenLimit: 65536,
            supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
          })),
        });
      }

      // 1. OpenAI-Compatible Endpoint: POST /v1/chat/completions
      //    - Plaintext thoughts -> `reasoning_content`
      //    - Answer text -> `content`
      //    - `thoughtSignature` is omitted (Gemini-only)
      if (req.method === 'POST' && pathname === '/v1/chat/completions') {
        const body = await readJsonBody(req);
        const auth = extractRequestAuth(req, body, relayClient, apiKey, url);

        if (body.stream) {
          const wireContents = buildWireContentsFromPayload(body);
          const extraBody = body.extra_body && typeof body.extra_body === 'object' ? body.extra_body : {};
          const generationConfig = {
            ...(body.generationConfig || body.generation_config || {}),
            temperature: body.temperature,
            topP: body.top_p,
            maxOutputTokens: body.max_tokens ?? body.max_completion_tokens,
            reasoningEffort:
              body.reasoning_effort ??
              body.reasoningEffort ??
              (body.reasoning && body.reasoning.effort) ??
              extraBody.reasoning_effort,
            thinkingConfig:
              body.thinking_config ||
              body.thinkingConfig ||
              extraBody.thinking_config ||
              (extraBody.google && extraBody.google.thinking_config),
          };
          const cleanModel = String(body.model || relayClient.defaultModel).replace(/^models\//, '');
          const streamId = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
          const created = Math.floor(Date.now() / 1000);

          let headersSent = false;
          let lastFinishReason = 'stop';
          let lastUsage = null;
          let toolCallIndex = 0;
          const tools = body.tools || body.functions || null;

          const ensureSseHeaders = (proofPkg) => {
            if (headersSent) return;
            headersSent = true;
            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-transform',
              Connection: 'keep-alive',
              'X-Accel-Buffering': 'no',
              'Access-Control-Allow-Origin': '*',
              ...proofMetaHeaders(proofPkg || {}),
            });
            const roleChunk = {
              id: streamId,
              object: 'chat.completion.chunk',
              created,
              model: cleanModel,
              choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);
          };

          await relayClient.streamGenerateContent(
            {
              wireContents,
              tools,
              model: body.model || relayClient.defaultModel,
              generationConfig,
              cookies: auth.cookies || relayClient.defaultCookies,
              authUser: auth.authUser ?? relayClient.defaultAuthUser,
              g1Tier: auth.g1Tier,
              accountId: auth.accountId || null,
              fromStore: !!auth.fromStore,
            },
            ({ deltaText, deltaThought, functionCalls, finishReasonCode, usage }) => {
              ensureSseHeaders();
              if (finishReasonCode === 2 && toolCallIndex === 0) lastFinishReason = 'length';
              if (usage) lastUsage = usage;

              if (deltaThought) {
                const thoughtChunk = {
                  id: streamId,
                  object: 'chat.completion.chunk',
                  created,
                  model: cleanModel,
                  choices: [
                    {
                      index: 0,
                      delta: { reasoning_content: deltaThought },
                      finish_reason: null,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(thoughtChunk)}\n\n`);
              }

              if (deltaText) {
                const textChunk = {
                  id: streamId,
                  object: 'chat.completion.chunk',
                  created,
                  model: cleanModel,
                  choices: [
                    {
                      index: 0,
                      delta: { content: deltaText },
                      finish_reason: null,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
              }

              if (Array.isArray(functionCalls) && functionCalls.length > 0) {
                lastFinishReason = 'tool_calls';
                const deltaToolCalls = functionCalls.map((item) => {
                  const fc = item.functionCall || item;
                  const idx = toolCallIndex++;
                  return {
                    index: idx,
                    id: fc.id || `call_${crypto.randomBytes(6).toString('hex')}_${idx}`,
                    type: 'function',
                    function: {
                      name: String(fc.name || ''),
                      arguments: JSON.stringify(fc.args || {}),
                    },
                  };
                });
                const toolChunk = {
                  id: streamId,
                  object: 'chat.completion.chunk',
                  created,
                  model: cleanModel,
                  choices: [
                    {
                      index: 0,
                      delta: { tool_calls: deltaToolCalls },
                      finish_reason: null,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(toolChunk)}\n\n`);
              }
            },
          );

          ensureSseHeaders();
          const stopChunk = {
            id: streamId,
            object: 'chat.completion.chunk',
            created,
            model: cleanModel,
            choices: [{ index: 0, delta: {}, finish_reason: lastFinishReason }],
            ...(lastUsage
              ? {
                  usage: buildOpenAIUsage(lastUsage),
                }
              : {}),
          };
          res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }

        const { response, meta } = await relayClient.chatCompletions(body, auth);
        applyProofMetaHeaders(res, meta);
        return sendJson(res, 200, response);
      }

      // 2. Gemini-Compatible Endpoint: POST /v1beta/models/{model}:generateContent or :streamGenerateContent
      //    - Plaintext thoughts -> `{ text, thought: true }`
      //    - Answer text -> `{ text }`
      //    - Thought signature -> `{ text: "", thoughtSignature: "..." }`
      //    - Multi-turn `contents` with `thoughtSignature` -> forwarded in `wire[1]` as 15-element array
      const geminiMatch = pathname.match(
        /^\/v1(?:beta)?\/models\/([^/:]+):(generateContent|streamGenerateContent)$/,
      );
      if (req.method === 'POST' && geminiMatch) {
        const model = decodeURIComponent(geminiMatch[1]);
        const action = geminiMatch[2];
        const body = await readJsonBody(req);
        const auth = extractRequestAuth(req, body, relayClient, apiKey, url);

        if (action === 'streamGenerateContent') {
          const wireContents = buildWireContentsFromPayload(body);
          const generationConfig = {
            ...(body.generationConfig || body.generation_config || {}),
            ...(body.thinkingConfig || body.thinking_config
              ? { thinkingConfig: body.thinkingConfig || body.thinking_config }
              : {}),
            ...(body.reasoning_effort || body.reasoningEffort
              ? { reasoningEffort: body.reasoning_effort || body.reasoningEffort }
              : {}),
          };
          const tools = body.tools || null;
          const cleanModel = String(model || relayClient.defaultModel).replace(/^models\//, '');
          let geminiHeadersSent = false;
          let sawFinishReason = false;
          let lastGeminiUsage = null;
          const ensureGeminiHeaders = () => {
            if (geminiHeadersSent) return;
            geminiHeadersSent = true;
            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-transform',
              Connection: 'keep-alive',
              'X-Accel-Buffering': 'no',
              'Access-Control-Allow-Origin': '*',
            });
          };

          await relayClient.streamGenerateContent(
            {
              wireContents,
              tools,
              model,
              generationConfig,
              cookies: auth.cookies || relayClient.defaultCookies,
              authUser: auth.authUser ?? relayClient.defaultAuthUser,
              g1Tier: auth.g1Tier,
              accountId: auth.accountId || null,
              fromStore: !!auth.fromStore,
            },
            ({ geminiParts, finishReasonCode, usage }) => {
              if ((!geminiParts || geminiParts.length === 0) && finishReasonCode == null && !usage) return;
              if (usage) lastGeminiUsage = usage;
              const hasParts = Array.isArray(geminiParts) && geminiParts.length > 0;
              const hasFinish = finishReasonCode !== null && finishReasonCode !== undefined;
              // Skip pure provisional usage-only frames that carry neither parts nor finishReason
              if (!hasParts && !hasFinish) return;
              ensureGeminiHeaders();
              const candidate = {
                content: {
                  role: 'model',
                  parts: hasParts ? geminiParts : [{ text: '' }],
                },
                index: 0,
              };
              if (hasFinish) {
                sawFinishReason = true;
                candidate.finishReason = FINISH_REASON_MAP[finishReasonCode] || 'STOP';
              }
              const chunk = {
                candidates: [candidate],
                ...(hasFinish || usage
                  ? { usageMetadata: buildGeminiUsageMetadata(usage || lastGeminiUsage) }
                  : {}),
                modelVersion: cleanModel,
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            },
          );
          ensureGeminiHeaders();
          if (!sawFinishReason) {
            const finalChunk = {
              candidates: [
                {
                  content: { role: 'model', parts: [{ text: '' }] },
                  finishReason: 'STOP',
                  index: 0,
                },
              ],
              usageMetadata: buildGeminiUsageMetadata(lastGeminiUsage),
              modelVersion: cleanModel,
            };
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
          }
          return res.end();
        }

        const { response, meta } = await relayClient.geminiGenerateContent(body, model, auth);
        applyProofMetaHeaders(res, meta);
        return sendJson(res, 200, response);
      }

      return sendJson(res, 404, { error: { message: `Route not found: ${req.method} ${pathname}` } });
    } catch (err) {
      const status = err.httpStatus || 500;
      if (res.headersSent) {
        console.warn(
          `[relay] 流式响应中途出错 (${status}): ${err && err.message ? err.message : String(err)}`,
        );
      }
      if (err && err.officialError) {
        return sendJson(res, status, err.officialError);
      }
      return sendJson(res, status, {
        error: {
          message: err && err.message ? err.message : String(err),
          type: 'relay_error',
          code: status,
        },
      });
    }
  });

  let rotatingAll = false;
  const rotateAllAccounts = async (forceAll = false) => {
    if (rotatingAll) return;
    rotatingAll = true;
    try {
      const now = Date.now();
      const seenAnchors = new Set();
      for (const entry of relayClient.accountStore.accounts.values()) {
        if (entry && entry.cookies) {
          const lastTs = Number(entry.lastRotatedAt || entry.updatedAt || entry.addedAt || 0);
          if (!forceAll && lastTs && now - lastTs < 240_000) {
            continue;
          }
          const anchor = computeSessionAnchor(extractMinimalCookies(entry.cookies).map);
          if (anchor) {
            if (seenAnchors.has(anchor)) continue;
            seenAnchors.add(anchor);
          }
          await relayClient.rotateAccountCookies(entry.cookies, entry.authUser);
          entry.lastRotatedAt = Date.now();
        }
      }
    } catch {} finally {
      rotatingAll = false;
    }
  };
  const startupRotateTimer = setTimeout(() => rotateAllAccounts(false), 3_000);
  if (startupRotateTimer && typeof startupRotateTimer.unref === 'function') {
    startupRotateTimer.unref();
  }
  const rotateTimer = setInterval(() => rotateAllAccounts(false), 60_000);
  if (rotateTimer && typeof rotateTimer.unref === 'function') {
    rotateTimer.unref();
  }

  return {
    relayClient,
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve());
      });
      const addr = server.address();
      const actualPort = addr && typeof addr === 'object' ? addr.port : port;
      return {
        host,
        port: actualPort,
        url: `http://${host}:${actualPort}`,
      };
    },
    async close() {
      clearInterval(rotateTimer);
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = {
  WaaRelayClient,
  createRelayServer,
  IncrementalJspbFrameParser,
  parseSingleMakerSuiteFrame,
  parseMakerSuiteResponse,
  buildGenerateWireBody,
  buildWireContentsFromPayload,
  encodeProtobufStruct,
  decodeProtobufStruct,
  encodeToolsWire,
  toOpenAIChatCompletion,
  toGeminiResponse,
};
