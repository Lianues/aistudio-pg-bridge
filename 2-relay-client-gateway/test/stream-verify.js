'use strict';

/**
 * End-to-End Verification for:
 *   1. OpenAI SSE streaming (`/v1/chat/completions`):
 *      - Plaintext thought summary (`part[12] = 1`) -> `delta.reasoning_content`
 *      - Answer text -> `delta.content`
 *      - `thoughtSignature` omitted in OpenAI format
 *   2. Gemini format (`/v1beta/models/{model}:generateContent` & `:streamGenerateContent`):
 *      - Plaintext thought summary -> `{ text, thought: true }`
 *      - Answer text -> `{ text }`
 *      - `thoughtSignature` (`part[14]`) -> `{ text: "", thoughtSignature: "EtIGCs8GA..." }`
 *      - Multi-turn round-trip: client sends `thoughtSignature` back in `contents`,
 *        relay forwards exact 15-element array `[null,"",null,...,null,"EtIGCs8GA..."]`
 *        at the end of the `model` turn in `wire[1]`, and Proof Server receives `wireContents`.
 */

const http = require('node:http');
const assert = require('node:assert');
const { createRelayServer } = require('../src/relay-server');

async function runTest() {
  let lastProofMintBody = null;

  // 1. Mock Proof Server
  const mockProofServer = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/proof/mint') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      lastProofMintBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          ok: true,
          proof: '!mock_v_proof_token_123456',
          proofMode: 'V',
          proofLength: 26,
          digest: 'deadbeef',
          model: 'models/gemini-4-argon',
          accountId: 'acc_test1234567890',
          poolState: 'hot',
          timingMs: { total: 12, init: 0, mint: 12 },
          auth: {
            cookies: 'SID=test_sid; SAPISID=test_sapisid',
            authorization: 'SAPISIDHASH 1793150000_test',
            googleApiKey: 'AIzaSyTestKey',
            authUser: 0,
            g1Tier: 'TIER1',
            origin: 'https://aistudio.google.com',
          },
        }),
      );
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hotAccounts: 1, coldAccounts: 0 }));
  });

  await new Promise((r) => mockProofServer.listen(0, '127.0.0.1', r));
  const proofPort = mockProofServer.address().port;

  // 2. Mock Google MakerSuite GenerateContent server
  let capturedUpstreamHeaders = null;
  let capturedUpstreamWire = null;
  let mockMode = 'text_and_thought';
  const mockGoogleUpstream = http.createServer(async (req, res) => {
    capturedUpstreamHeaders = req.headers;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    capturedUpstreamWire = JSON.parse(Buffer.concat(chunks).toString('utf8'));

    res.writeHead(200, {
      'Content-Type': 'application/json+protobuf',
      'Transfer-Encoding': 'chunked',
    });

    if (mockMode === 'image_gen') {
      const imgPart = [
        null,
        null,
        ['image/jpeg', 'FAKE_JPEG_BASE64_DATA_12345'],
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
        'EtIGCs8GA_IMAGE_SIG==',
      ];
      res.write('[[');
      res.write(JSON.stringify([[[[[imgPart], 'model'], 1]], null, [10, 260, 270]]));
      res.write(']]');
      return res.end();
    }

    if (mockMode === 'parallel_tools') {
      // Simulate parallel function calls (`getWeather("Tokyo")` and `getWeather("Paris")`)
      // with thought summary + thoughtSignature attached to the first functionCall part
      const thoughtPart = [
        null,
        '用户同时问了东京和巴黎的天气，并行调用两次 getWeather。',
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
        1,
      ];
      const fc1Part = [
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
        ['getWeather', [[['city', [null, null, 'Tokyo']]]], 'call_tokyo_1'],
        null,
        null,
        null,
        'EtIGCs8GA_PARALLEL_FC_SIG==',
      ];
      const fc2Part = [
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
        ['getWeather', [[['city', [null, null, 'Paris']]]], 'call_paris_2'],
      ];

      res.write('[[');
      res.write(JSON.stringify([[[[[thoughtPart], 'model']]], null, [15, 5, 20]]));
      res.write(',' + JSON.stringify([[[[[fc1Part, fc2Part], 'model'], 1]], null, [15, 18, 33]]));
      res.write(']]');
      return res.end();
    }

    // Frame 1: Plaintext thinking summary (`part[12] = 1`)
    const thoughtPart = [
      null,
      '用户问的是 1+1，逐步推导得 2。',
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
      1,
    ];
    // Frame 2: Visible answer text (`part[1] = "2"`)
    const textPart = [null, '2'];
    // Frame 3: Thought signature (`part[14] = "EtIGCs8GA_TEST_SIGNATURE_BASE64=="`)
    const sigPart = [
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
      null,
      null,
      'EtIGCs8GA_TEST_SIGNATURE_BASE64==',
    ];

    res.write('[[');
    await new Promise((r) => setTimeout(r, 30));
    res.write(JSON.stringify([[[[[thoughtPart], 'model']]], null, [10, 5, 15]]));
    await new Promise((r) => setTimeout(r, 30));
    res.write(',' + JSON.stringify([[[[[textPart], 'model']]], null, [10, 6, 16]]));
    await new Promise((r) => setTimeout(r, 30));
    res.write(',' + JSON.stringify([[[[[sigPart], 'model'], 1]], null, [10, 8, 18]]));
    res.write(']]');
    res.end();
  });

  await new Promise((r) => mockGoogleUpstream.listen(0, '127.0.0.1', r));
  const googlePort = mockGoogleUpstream.address().port;

  // 3. Start Relay Gateway
  const relay = createRelayServer({
    host: '127.0.0.1',
    port: 0,
    proofServerUrl: `http://127.0.0.1:${proofPort}`,
    generateContentUrl: `http://127.0.0.1:${googlePort}/GenerateContent`,
    apiKey: 'sk-test-key',
  });
  const relayInfo = await relay.listen();

  // Add account
  await fetch(`${relayInfo.url}/v1/accounts/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: true,
      authUser: 0,
      g1Tier: 'TIER1',
      cookies: 'SID=test_sid; SAPISID=test_sapisid; __Secure-1PSID=test_1psid',
    }),
  });

  // 4. Test OpenAI SSE Streaming + Interleaved System Role Conversion
  const streamRes = await fetch(`${relayInfo.url}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test-key',
    },
    body: JSON.stringify({
      model: 'gemini-4-argon',
      stream: true,
      messages: [
        { role: 'system', content: '你是一个严谨的数学助手' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！请出题' },
        { role: 'system', content: '注意只输出数字' },
        { role: 'user', content: '1+1=' },
      ],
    }),
  });

  assert.strictEqual(streamRes.status, 200);
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  const sseEvents = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        sseEvents.push(line.slice(6).trim());
      }
    }
  }

  // Verify interleaved system messages were converted in-place to role="user"
  assert.deepStrictEqual(capturedUpstreamWire[1], [
    [[[null, '你是一个严谨的数学助手']], 'user'],
    [[[null, '你好']], 'user'],
    [[[null, '你好！请出题']], 'model'],
    [[[null, '注意只输出数字']], 'user'],
    [[[null, '1+1=']], 'user'],
  ]);
  assert.strictEqual(capturedUpstreamWire[5], undefined);

  const parsedDeltas = sseEvents
    .filter((e) => e !== '[DONE]')
    .map((e) => JSON.parse(e).choices?.[0]?.delta || {});

  const streamedReasoning = parsedDeltas.map((d) => d.reasoning_content || '').join('');
  const streamedContent = parsedDeltas.map((d) => d.content || '').join('');

  console.log('[OpenAI SSE reasoning_content]:', streamedReasoning);
  console.log('[OpenAI SSE content]:', streamedContent);
  assert.strictEqual(streamedReasoning, '用户问的是 1+1，逐步推导得 2。');
  assert.strictEqual(streamedContent, '2');
  // Verify OpenAI SSE did not include thoughtSignature
  assert.ok(!JSON.stringify(parsedDeltas).includes('EtIGCs8GA_TEST_SIGNATURE_BASE64=='));

  // 5. Test Gemini Format Turn 1 (`POST /v1beta/models/gemini-4-argon:generateContent`)
  //    Also verify `systemInstruction` -> index 0 `user`, and interleaved `role: "system"` -> `user`
  const gemTurn1Res = await fetch(
    `${relayInfo.url}/v1beta/models/gemini-4-argon:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': 'sk-test-key',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: '顶层系统指令' }] },
        contents: [
          { role: 'user', parts: [{ text: '第一句' }] },
          { role: 'model', parts: [{ text: '收到' }] },
          { role: 'system', parts: [{ text: '穿插的system消息' }] },
          { role: 'user', parts: [{ text: '1+1=' }] },
        ],
      }),
    },
  );
  const gemTurn1 = await gemTurn1Res.json();
  const turn1Parts = gemTurn1.candidates[0].content.parts;
  console.log('[Gemini Turn 1 Response Parts]:', JSON.stringify(turn1Parts));

  assert.deepStrictEqual(capturedUpstreamWire[1], [
    [[[null, '顶层系统指令']], 'user'],
    [[[null, '第一句']], 'user'],
    [[[null, '收到']], 'model'],
    [[[null, '穿插的system消息']], 'user'],
    [[[null, '1+1=']], 'user'],
  ]);

  assert.strictEqual(turn1Parts.length, 3);
  assert.deepStrictEqual(turn1Parts[0], {
    text: '用户问的是 1+1，逐步推导得 2。',
    thought: true,
  });
  assert.deepStrictEqual(turn1Parts[1], {
    text: '2',
  });
  assert.deepStrictEqual(turn1Parts[2], {
    text: '',
    thoughtSignature: 'EtIGCs8GA_TEST_SIGNATURE_BASE64==',
  });

  // 6. Test Gemini Format Turn 2 (Multi-turn round-trip with `thoughtSignature`)
  const gemTurn2Res = await fetch(
    `${relayInfo.url}/v1beta/models/gemini-4-argon:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': 'sk-test-key',
      },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: '1+1=' }] },
          { role: 'model', parts: turn1Parts },
          { role: 'user', parts: [{ text: '2+3=' }] },
        ],
      }),
    },
  );
  assert.strictEqual(gemTurn2Res.status, 200);

  // Verify the exact MakerSuite wire[1] sent to Google on Turn 2!
  console.log('[Turn 2 Upstream wire[1]]:', JSON.stringify(capturedUpstreamWire[1]));
  assert.deepStrictEqual(capturedUpstreamWire[1], [
    [[[null, '1+1=']], 'user'],
    [
      [
        [null, '2'],
        [
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
          null,
          null,
          'EtIGCs8GA_TEST_SIGNATURE_BASE64==',
        ],
      ],
      'model',
    ],
    [[[null, '2+3=']], 'user'],
  ]);

  // Verify Proof Server received the exact `wireContents` so `_.SB` digest matches!
  assert.deepStrictEqual(lastProofMintBody.wireContents, capturedUpstreamWire[1]);

  // 7. Test Gemini Function Calling (Parallel Tool Calls + `thoughtSignature` + `functionResponse` Round-Trip)
  mockMode = 'parallel_tools';
  const fcTurn1Res = await fetch(
    `${relayInfo.url}/v1beta/models/gemini-4-argon:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': 'sk-test-key',
      },
      body: JSON.stringify({
        tools: [
          {
            functionDeclarations: [
              {
                name: 'getWeather',
                description: 'Get weather in a city',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    city: { type: 'STRING', description: 'City name' },
                  },
                  required: ['city'],
                },
              },
            ],
          },
        ],
        contents: [{ role: 'user', parts: [{ text: '东京和巴黎天气如何？' }] }],
      }),
    },
  );
  const fcTurn1 = await fcTurn1Res.json();
  const fcModelParts = fcTurn1.candidates[0].content.parts;
  console.log('[Gemini Parallel FunctionCall Response Parts]:', JSON.stringify(fcModelParts));

  assert.ok(Array.isArray(capturedUpstreamWire[6]));
  assert.strictEqual(capturedUpstreamWire[6][0][1][0][0], 'getWeather');

  assert.strictEqual(fcModelParts.length, 3);
  assert.deepStrictEqual(fcModelParts[0], {
    text: '用户同时问了东京和巴黎的天气，并行调用两次 getWeather。',
    thought: true,
  });
  assert.deepStrictEqual(fcModelParts[1], {
    functionCall: {
      name: 'getWeather',
      args: { city: 'Tokyo' },
      id: 'call_tokyo_1',
    },
    thoughtSignature: 'EtIGCs8GA_PARALLEL_FC_SIG==',
  });
  assert.deepStrictEqual(fcModelParts[2], {
    functionCall: {
      name: 'getWeather',
      args: { city: 'Paris' },
      id: 'call_paris_2',
    },
  });

  // Turn 2: Client sends back `fcModelParts` (including `thoughtSignature`) + parallel `functionResponse` parts
  mockMode = 'text_and_thought';
  const fcTurn2Res = await fetch(
    `${relayInfo.url}/v1beta/models/gemini-4-argon:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': 'sk-test-key',
      },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: '东京和巴黎天气如何？' }] },
          { role: 'model', parts: fcModelParts },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'getWeather',
                  id: 'call_tokyo_1',
                  response: { temp: 22, condition: 'Sunny' },
                },
              },
              {
                functionResponse: {
                  name: 'getWeather',
                  id: 'call_paris_2',
                  response: { temp: 16, condition: 'Rainy' },
                },
              },
            ],
          },
        ],
      }),
    },
  );
  assert.strictEqual(fcTurn2Res.status, 200);

  console.log('[Parallel FunctionCall + FunctionResponse Turn 2 wire[1]]:', JSON.stringify(capturedUpstreamWire[1]));

  const modelTurnWire = capturedUpstreamWire[1][1];
  assert.strictEqual(modelTurnWire[1], 'model');
  assert.strictEqual(modelTurnWire[0].length, 2);
  assert.strictEqual(modelTurnWire[0][0][10][0], 'getWeather');
  assert.strictEqual(modelTurnWire[0][0][14], 'EtIGCs8GA_PARALLEL_FC_SIG==');
  assert.strictEqual(modelTurnWire[0][1][10][0], 'getWeather');

  const fnRespTurnWire = capturedUpstreamWire[1][2];
  assert.strictEqual(fnRespTurnWire[1], 'user');
  assert.strictEqual(fnRespTurnWire[0].length, 2);
  assert.strictEqual(fnRespTurnWire[0][0][11][0], 'getWeather');
  assert.strictEqual(fnRespTurnWire[0][0][11][2], 'call_tokyo_1');
  assert.strictEqual(fnRespTurnWire[0][1][11][0], 'getWeather');
  assert.strictEqual(fnRespTurnWire[0][1][11][2], 'call_paris_2');
  assert.deepStrictEqual(lastProofMintBody.wireContents, capturedUpstreamWire[1]);

  // 8. Test OpenAI User Multimodal Image (`image_url` data:image/png;base64,...)
  const oaiImgRes = await fetch(`${relayInfo.url}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test-key',
    },
    body: JSON.stringify({
      model: 'gemini-4-argon',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图里有什么？' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' },
            },
          ],
        },
      ],
    }),
  });
  assert.strictEqual(oaiImgRes.status, 200);
  console.log('[OpenAI Multimodal Image wire[1]]:', JSON.stringify(capturedUpstreamWire[1]));
  assert.deepStrictEqual(capturedUpstreamWire[1], [
    [
      [
        [null, '这张图里有什么？'],
        [null, null, ['image/png', 'iVBORw0KGgoAAAANSUhEUg==']],
      ],
      'user',
    ],
  ]);

  // 9. Test Gemini Multimodal Function Calling (`read_image` tool returning local Base64 image)
  const mmToolRes = await fetch(
    `${relayInfo.url}/v1beta/models/gemini-4-argon:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': 'sk-test-key',
      },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: '帮我读取 /tmp/screen.png 的内容' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'read_image',
                  args: { path: '/tmp/screen.png' },
                  id: 'call_img_1',
                },
                thoughtSignature: 'EtIGCs8GA_READ_IMG_SIG==',
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'read_image',
                  id: 'call_img_1',
                  response: { status: 'ok', path: '/tmp/screen.png' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'image/png',
                        data: 'iVBORw0KGgoAAAANSUhEUg==',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    },
  );
  assert.strictEqual(mmToolRes.status, 200);
  console.log('[Gemini Multimodal Tool Response wire[1][2]]:', JSON.stringify(capturedUpstreamWire[1][2]));
  assert.deepStrictEqual(capturedUpstreamWire[1][2], [
    [
      [
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
        [
          'read_image',
          [
            [
              ['status', [null, null, 'ok']],
              ['path', [null, null, '/tmp/screen.png']],
            ],
          ],
          'call_img_1',
        ],
      ],
      [null, null, ['image/png', 'iVBORw0KGgoAAAANSUhEUg==']],
    ],
    'user',
  ]);

  // 10. Test OpenAI Tool Calling (Non-Streaming `message.tool_calls` + Streaming `delta.tool_calls` + Multi-Turn `role: "tool"` Replay without `thoughtSignature`)
  mockMode = 'parallel_tools';
  const oaiTools = [
    {
      type: 'function',
      function: {
        name: 'getWeather',
        description: 'Get weather in a city',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: 'City name' },
          },
          required: ['city'],
        },
      },
    },
  ];
  const oaiFcTurn1Res = await fetch(`${relayInfo.url}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test-key',
    },
    body: JSON.stringify({
      model: 'gemini-4-argon',
      tools: oaiTools,
      messages: [{ role: 'user', content: '东京和巴黎天气如何？' }],
    }),
  });
  assert.strictEqual(oaiFcTurn1Res.status, 200);
  const oaiFcTurn1 = await oaiFcTurn1Res.json();
  console.log('[OpenAI Parallel tool_calls Response]:', JSON.stringify(oaiFcTurn1.choices[0]));
  assert.strictEqual(oaiFcTurn1.choices[0].finish_reason, 'tool_calls');
  assert.strictEqual(oaiFcTurn1.choices[0].message.content, null);
  assert.strictEqual(oaiFcTurn1.choices[0].message.tool_calls.length, 2);
  assert.deepStrictEqual(oaiFcTurn1.choices[0].message.tool_calls[0], {
    id: 'call_tokyo_1',
    type: 'function',
    function: {
      name: 'getWeather',
      arguments: JSON.stringify({ city: 'Tokyo' }),
    },
  });

  // Streaming OpenAI tool_calls (`delta.tool_calls`)
  const oaiStreamToolRes = await fetch(`${relayInfo.url}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test-key',
    },
    body: JSON.stringify({
      model: 'gemini-4-argon',
      stream: true,
      tools: oaiTools,
      messages: [{ role: 'user', content: '东京和巴黎天气如何？' }],
    }),
  });
  const oaiStreamToolText = await oaiStreamToolRes.text();
  assert.ok(oaiStreamToolText.includes('"tool_calls"'));
  assert.ok(oaiStreamToolText.includes('"finish_reason":"tool_calls"'));

  // Turn 2: Client replays OpenAI `assistant` message with `tool_calls` (NO thoughtSignature!) + two `role: "tool"` messages
  mockMode = 'text_and_thought';
  const oaiFcTurn2Res = await fetch(`${relayInfo.url}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test-key',
    },
    body: JSON.stringify({
      model: 'gemini-4-argon',
      tools: oaiTools,
      messages: [
        { role: 'user', content: '东京和巴黎天气如何？' },
        {
          role: 'assistant',
          content: null,
          tool_calls: oaiFcTurn1.choices[0].message.tool_calls,
        },
        {
          role: 'tool',
          tool_call_id: 'call_tokyo_1',
          content: JSON.stringify({ temp: 22, condition: 'Sunny' }),
        },
        {
          role: 'tool',
          tool_call_id: 'call_paris_2',
          content: JSON.stringify({ temp: 16, condition: 'Rainy' }),
        },
      ],
    }),
  });
  assert.strictEqual(oaiFcTurn2Res.status, 200);
  const oaiModelTurnWire = capturedUpstreamWire[1][1];
  const oaiToolRespTurnWire = capturedUpstreamWire[1][2];
  assert.strictEqual(oaiModelTurnWire[1], 'model');
  assert.strictEqual(oaiModelTurnWire[0].length, 2);
  // First functionCall part automatically carries `btoa("skip_thought_signature_validator")` at index 14!
  assert.strictEqual(
    oaiModelTurnWire[0][0][14],
    Buffer.from('skip_thought_signature_validator', 'utf8').toString('base64'),
  );
  assert.strictEqual(oaiModelTurnWire[0][1].length, 11);
  // Consecutive `role: "tool"` messages are merged into a single `"user"` turn with 2 functionResponse parts
  assert.strictEqual(oaiToolRespTurnWire[1], 'user');
  assert.strictEqual(oaiToolRespTurnWire[0].length, 2);
  assert.strictEqual(oaiToolRespTurnWire[0][0][11][0], 'getWeather');
  assert.strictEqual(oaiToolRespTurnWire[0][0][11][2], 'call_tokyo_1');
  assert.strictEqual(oaiToolRespTurnWire[0][1][11][0], 'getWeather');
  assert.strictEqual(oaiToolRespTurnWire[0][1][11][2], 'call_paris_2');

  // 10. Test Image Generation Models (`gemini-nano-banana-2.1`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`)
  //     - Verify `/v1/models` includes `gemini-3.5-flash-lite` + 4 image models and removes `gemini-2.5-*`
  const modelsRes = await fetch(`${relayInfo.url}/v1/models`).then((r) => r.json());
  const modelIds = modelsRes.data.map((m) => m.id);
  assert.ok(modelIds.includes('gemini-3.5-flash-lite'));
  assert.ok(modelIds.includes('gemini-nano-banana-2.1'));
  assert.ok(modelIds.includes('gemini-3.1-flash-image'));
  assert.ok(modelIds.includes('gemini-3.1-flash-lite-image'));
  assert.ok(modelIds.includes('gemini-3-pro-image'));
  assert.ok(!modelIds.some((id) => id.startsWith('gemini-2.5')));

  //     - Test Gemini format image response (`inlineData`) + `wire[3][14] = [1, 2]`
  mockMode = 'image_gen';
  const gemImgRes = await fetch(
    `${relayInfo.url}/v1beta/models/gemini-nano-banana-2.1:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'sk-test-key' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: '画一根香蕉' }] }],
      }),
    },
  ).then((r) => r.json());
  assert.strictEqual(capturedUpstreamWire[0], 'models/gemini-nano-banana-2.1');
  assert.deepStrictEqual(capturedUpstreamWire[3][14], [1, 2]);
  assert.strictEqual(capturedUpstreamWire[3][16], null);
  assert.deepStrictEqual(gemImgRes.candidates[0].content.parts[0], {
    inlineData: { mimeType: 'image/jpeg', data: 'FAKE_JPEG_BASE64_DATA_12345' },
    thoughtSignature: 'EtIGCs8GA_IMAGE_SIG==',
  });

  //     - Test OpenAI format image response (Markdown `![image](data:image/jpeg;base64,...)`)
  const oaiGenImgRes = await fetch(`${relayInfo.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test-key' },
    body: JSON.stringify({
      model: 'gemini-3.1-flash-image',
      messages: [{ role: 'user', content: '画一根香蕉' }],
    }),
  }).then((r) => r.json());
  assert.strictEqual(capturedUpstreamWire[0], 'models/gemini-3.1-flash-image');
  assert.deepStrictEqual(capturedUpstreamWire[3][14], [1, 2]);
  assert.strictEqual(
    oaiGenImgRes.choices[0].message.content,
    '![image](data:image/jpeg;base64,FAKE_JPEG_BASE64_DATA_12345)',
  );

  // 11. Test Account Liveness Check (`POST /api/accounts/test` -> calls `models/gemini-3.5-flash-lite`)
  mockMode = 'text_and_thought';
  const statusList = await fetch(`${relayInfo.url}/api/status`).then((r) => r.json());
  const firstAccId = statusList.accounts[0].accountId;
  const testAccRes = await fetch(`${relayInfo.url}/api/accounts/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: firstAccId }),
  }).then((r) => r.json());
  assert.strictEqual(testAccRes.ok, true);
  assert.strictEqual(testAccRes.alive, true);
  assert.strictEqual(testAccRes.model, 'gemini-3.5-flash-lite');
  assert.strictEqual(capturedUpstreamWire[0], 'models/gemini-3.5-flash-lite');

  await relay.close();
  await new Promise((r) => mockProofServer.close(r));
  await new Promise((r) => mockGoogleUpstream.close(r));
  console.log('ALL OPENAI SSE + GEMINI THOUGHT & THOUGHT_SIGNATURE TESTS PASSED!');
}

runTest().catch((err) => {
  console.error(err);
  process.exit(1);
});
