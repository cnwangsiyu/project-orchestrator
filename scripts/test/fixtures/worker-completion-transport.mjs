import './worker-guards-transport.mjs';
import fs from 'node:fs';
import { readEvents } from '../../lib/worker-events.mjs';
import { pollWorkerQuota } from '../../lib/worker-quota-refresh.mjs';
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
    if (config.reportingProbe && this.historyReads > 1 && message.result?.thread?.turns) {
      const rows = readEvents(), row = rows.findLast(row => row.event === 'running');
      let refreshes = 0;
      void pollWorkerQuota({ owner: row.owner, rows, profiles: { fixture: { kind: 'trae' } },
        data: { checkedAt: Date.now() - 30 * 60000, codexAccounts: [{ name: 'fixture', kind: 'trae' }] },
        refresh: async () => { refreshes++; return { status: 'unavailable', accounts: { fixture: 'unavailable' } }; }
      }).then(result => {
        fs.writeFileSync(config.reportingProbe, JSON.stringify({ row, result, refreshes }));
        super.notify(message);
      });
      return;
    }
    super.notify(message);
  }
};
