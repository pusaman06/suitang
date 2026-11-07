/**
 * 本地 DeepSeek mock（e2e 用）。
 * 只实现 /chat/completions 的 SSE 流，记录收到的请求体供断言。
 */
import http from 'node:http';

export const DEFAULT_ANSWER =
  '结论：这段在讲变量赋值 [00:12]。\n补充：没有更多内容。\n测试全文结束。';

/** `kb:draft` 的摘要请求：一句话摘要 + 关键词。 */
export const DEFAULT_KB_ANSWER = JSON.stringify({
  summary: '测试摘要：这期讲了 Python 入门基础。',
  keywords: ['Python', '入门'],
});

// 9 段，覆盖到 900s；parseOutline 会按时长 clamp 末段。
export const DEFAULT_OUTLINE_ANSWER = JSON.stringify([
  { start: 0, end: 100, title: '课程介绍与学习路线' },
  { start: 100, end: 200, title: '开发环境与工具准备' },
  { start: 200, end: 300, title: 'Python 基础语法概览' },
  { start: 300, end: 400, title: '变量与数据类型讲解' },
  { start: 400, end: 500, title: '条件判断与循环结构' },
  { start: 500, end: 600, title: '函数定义与参数使用' },
  { start: 600, end: 700, title: '实战项目结构说明' },
  { start: 700, end: 800, title: '调试与常见错误排查' },
  { start: 800, end: 900, title: '总结与后续学习建议' },
]);

// 6 张截图 → 6 个标题；相邻相同会被 framesToSegments 合并。
export const DEFAULT_FRAME_TITLES = JSON.stringify([
  '开场与目标说明',
  '一句话出图',
  '手机操控演示',
  '语音输入',
  '扫码查看与分享',
  '公测信息与安装',
]);

function isOutlineRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.some(
    message => typeof message?.content === 'string' && message.content.includes('课程笔记助手'),
  );
}

/** 抽帧大纲请求：大纲的 system 提示 + user 里夹了 image_url。问答带图不算。 */
function isFrameRequest(body) {
  return isOutlineRequest(body) && countFrameImages(body) > 0;
}

/** 知识库摘要请求（`kb:draft` 的「一句话摘要 + 关键词」）。 */
function isKbSummaryRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.some(
    message => typeof message?.content === 'string' && message.content.includes('知识库条目'),
  );
}

/** 细节请求（第二轮补说明）：user 里带「## 第 1 段」，不消耗大纲答案队列。 */
function isDetailRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.some(
    message => typeof message?.content === 'string' && message.content.includes('## 第 1 段'),
  );
}

function countFrameImages(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let count = 0;
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) if (part?.type === 'image_url') count += 1;
  }
  return count;
}

/** 标题数量必须和截图数一致，后端按这个做长度校验。 */
function frameTitlesFor(count) {
  return JSON.stringify(Array.from({ length: count }, (_, index) => `第 ${index + 1} 段主题`));
}

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function createMockServer() {
  /** @type {{ status: number, answer: string, outlineAnswer: string, frameAnswer: string, delayMs: number, outlineQueue: string[] | null }} */
  const state = {
    status: 200,
    answer: DEFAULT_ANSWER,
    outlineAnswer: DEFAULT_OUTLINE_ANSWER,
    frameAnswer: DEFAULT_FRAME_TITLES,
    delayMs: 80,
    // 分级重试用例：按顺序返回的切段答案，剩下最后一项时一直用它。
    outlineQueue: null,
  };
  /** @type {Array<{ method: string, url: string, headers: Record<string, string>, body: any }>} */
  const requests = [];

  /** 每次「切段」请求取一项；detail 请求不走这里。 */
  const nextOutlineAnswer = () => {
    const queue = state.outlineQueue;
    if (!Array.isArray(queue) || queue.length === 0) return state.outlineAnswer;
    return queue.length === 1 ? queue[0] : queue.shift();
  };

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
      const frameCount = isFrameRequest(body) ? countFrameImages(body) : 0;
      let rest =
        frameCount > 0
          ? frameTitlesFor(frameCount)
          : isOutlineRequest(body)
            ? isDetailRequest(body)
              ? state.outlineAnswer
              : nextOutlineAnswer()
            : isKbSummaryRequest(body)
              ? DEFAULT_KB_ANSWER
              : state.answer;
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
              prompt_cache_hit_tokens: 0,
              prompt_cache_miss_tokens: 1234,
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
      state.outlineAnswer = DEFAULT_OUTLINE_ANSWER;
      state.frameAnswer = DEFAULT_FRAME_TITLES;
      state.delayMs = 80;
      state.outlineQueue = null;
    },
  };
}
