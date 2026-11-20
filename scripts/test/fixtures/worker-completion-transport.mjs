import './worker-guards-transport.mjs';
const config = JSON.parse(process.env.WORKER_GUARDS_FIXTURE);
const Base = globalThis.WebSocket;
globalThis.WebSocket = class extends Base {
  notify(message) {
    if (config.historyItems && message.result?.thread?.turns) {
      const items = config.historyItems[Math.min(this.historyReads ?? 0, config.historyItems.length - 1)];
      this.historyReads = (this.historyReads ?? 0) + 1;
      message.result.thread.turns = message.result.thread.turns.map(turn => ({ ...turn, items }));
    }
    if (message.method === 'turn/completed') {
      if (config.omitCompletion) {
        if (config.disconnect) this.onclose?.();
        return;
      }
      message.params.turn = { ...message.params.turn, ...config.terminal };
    }
    super.notify(message);
  }
};
