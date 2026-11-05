/**
 * 本地 DeepSeek mock（e2e 用）。
 * 只实现 /chat/completions 的 SSE 流，记录收到的请求体供断言。
 */
import http from 'node:http';

export const DEFAULT_ANSWER =
  '结论：这段在讲变量赋值 [00:12]。\n补充：没有更多内容。\n测试全文结束。';

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function createMockServer() {
  /** @type {{ status: number, answer: string, delayMs: number }} */
  const state = { status: 200, answer: DEFAULT_ANSWER, delayMs: 80 };
  /** @type {Array<{ method: string, url: string, headers: Record<string, string>, body: any }>} */
  const requests = [];

  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    const chunks = [];
    req.on('data', part => chunks.push(part));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });

      if (state.status !== 200) {
        res.writeHead(state.status, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `mock ${state.status}`, type: 'mock' } }));
        return;
      }

      res.writeHead(200, {
        ...cors,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const pieces = [];
      let rest = state.answer;
      // 切成 6 字左右的小片，模拟逐字返回。
      while (rest.length > 0) {
        pieces.push(rest.slice(0, 6));
        rest = rest.slice(6);
      }

      let index = 0;
      const writeNext = () => {
        if (index < pieces.length) {
          res.write(sseChunk({ choices: [{ delta: { content: pieces[index] } }] }));
          index += 1;
          setTimeout(writeNext, state.delayMs);
          return;
        }
        res.write(
          sseChunk({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 1234,
              completion_tokens: 56,
              total_tokens: 1290,
              prompt_tokens_details: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1234 },
              completion_tokens_details: { reasoning_tokens: 0 },
            },
          }),
        );
        res.write('data: [DONE]\n\n');
        res.end();
      };

      // 首片立即发，保证「5 秒内出字」可测。
      writeNext();
    });
  });

  return {
    state,
    requests,
    async listen() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      return `http://127.0.0.1:${port}`;
    },
    async close() {
      await new Promise(resolve => server.close(resolve));
    },
    reset() {
      requests.length = 0;
      state.status = 200;
      state.answer = DEFAULT_ANSWER;
      state.delayMs = 80;
    },
  };
}
