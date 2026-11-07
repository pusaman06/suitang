/**
 * 本地 SiliconFlow ASR mock（e2e 用）。
 * - POST /v1/audio/transcriptions：假转写，记录上传大小与调用次数。
 * - GET 任意路径：假音轨（默认 200 / 262KB）。用 state.audioStatus 按路径改成 500，
 *   模拟某条 CDN 线路挂掉；所有 GET 按到达顺序记进 audioRequests，供
 *   「先试哪条候选、有没有换线、失败后是否继续」的断言用。
 */
import http from 'node:http';

export const DEFAULT_ASR_TEXT =
  '第一段转写讲的是开场目标和整体流程。第二句话在这里解释一句话生成图片的步骤。第三句补充手机操控和语音输入的具体做法。第四句用来检查时间戳分配是否均匀合理，以及最终的大纲分段效果。';

/** 假音轨大小：足够让整段上传路径拿到一个非空文件。 */
const AUDIO_BYTES = 262_144;

export function createMockAsrServer() {
  /** @type {{ texts: string[], status: number, delayMs: number, audioDelayMs: number, audioStatus: Record<string, number> }} */
  const state = {
    texts: [DEFAULT_ASR_TEXT],
    status: 200,
    delayMs: 400,
    audioDelayMs: 250,
    /** 按路径覆盖 GET 状态码，未配置的路径一律 200。 */
    audioStatus: {},
  };
  /** @type {Array<{ contentType: string, bytes: number, at: number }>} */
  const requests = [];
  /** @type {Array<{ path: string, status: number, at: number }>} GET 请求记录（按到达顺序）。 */
  const audioRequests = [];

  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET') {
      const status = Number(state.audioStatus[url.pathname] ?? 200);
      audioRequests.push({ path: url.pathname, status, at: Date.now() });
      if (status !== 200) {
        // 失败立即返回：候选回退链路要靠 500 快速走到下一条，不拖测试时间。
        res.writeHead(status, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: `mock audio ${status}` }));
        return;
      }
      // /audio.m4a 和用例自造的任意路径都走这里，行为与原来的固定路径一致。
      setTimeout(() => {
        res.writeHead(200, {
          ...cors,
          'Content-Type': 'audio/mp4',
          'Content-Length': String(AUDIO_BYTES),
        });
        res.end(Buffer.alloc(AUDIO_BYTES, 0x41));
      }, state.audioDelayMs);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        requests.push({
          contentType: String(req.headers['content-type'] ?? ''),
          bytes: body.length,
          at: Date.now(),
        });

        if (state.status !== 200) {
          res.writeHead(state.status, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: `mock ${state.status}` }));
          return;
        }

        const text = state.texts[Math.min(requests.length - 1, state.texts.length - 1)] ?? '';
        setTimeout(() => {
          res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text }));
        }, state.delayMs);
      });
      return;
    }

    res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'not found' }));
  });

  return {
    state,
    requests,
    /** GET 请求顺序（含失败路径），用例按它断言候选顺序。 */
    audioRequests,
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
      audioRequests.length = 0;
      state.texts = [DEFAULT_ASR_TEXT];
      state.status = 200;
      state.delayMs = 400;
      state.audioDelayMs = 250;
      state.audioStatus = {};
    },
  };
}
