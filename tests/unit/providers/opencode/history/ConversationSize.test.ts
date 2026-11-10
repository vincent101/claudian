import type * as fsPromises from 'fs/promises';

import type { Conversation } from '@/core/types';
import { OpencodeConversationHistoryService } from '@/providers/opencode/history/OpencodeConversationHistoryService';
import * as historyStore from '@/providers/opencode/history/OpencodeHistoryStore';

it('does not attribute a shared OpenCode database to one conversation', async () => {
  const conversation: Conversation = {
    id: 'open', providerId: 'opencode', title: 'Open', createdAt: 1, updatedAt: 1,
    sessionId: 'session', messages: [], providerState: { databasePath: '/fixture/shared.db' },
  };
  const service = new OpencodeConversationHistoryService();
  const stat = jest.spyOn(jest.requireActual<typeof fsPromises>('fs/promises'), 'stat');
  const query = jest.spyOn(historyStore, 'loadOpencodeSessionMessages');
  const hydrate = jest.spyOn(service, 'hydrateConversationHistory');
  const observation = await service.readConversationSize({
    id: conversation.id, providerId: conversation.providerId, source: service.captureConversationSizeSource(conversation),
  }, '/fixture', { revision: 1 });
  const snapshot = observation.snapshot;
  expect(snapshot.files).toEqual({ status: 'unknown', reason: 'unsupported' });
  expect(snapshot).not.toHaveProperty('history');
  expect(hydrate).not.toHaveBeenCalled();
  expect(stat).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
  conversation.sessionId = null;
  expect(await service.hydrateConversationHistory(conversation, null)).toBeUndefined();
  expect(query).not.toHaveBeenCalled();
  stat.mockRestore(); query.mockRestore(); hydrate.mockRestore();
});
