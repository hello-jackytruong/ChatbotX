import { zaloOps } from '../../shared/zalo-operations.js';
import { sendNativeVideo } from '../../shared/video-processor.js';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { GatewayCredentialStore } from '../gateway/credential-store.js';
import { backfillAccountHistory } from '../zalo/zalo-history-backfill.js';
import { zaloPool } from '../zalo/zalo-pool.js';
import type { ProviderCommandV1, ProviderOperationName } from './contracts.js';

type ProviderOperation = (accountId: string, ...args: any[]) => Promise<unknown>;

function defer(operation: ProviderOperationName): ProviderOperation {
  return (accountId, ...args) => {
    const handler = (zaloOps as unknown as Record<string, ProviderOperation>)[operation];
    if (!handler) {
      throw Object.assign(new Error(`Unsupported provider operation: ${operation}`), {
        code: 'INVALID_PARAMS',
        statusCode: 400,
      });
    }
    return handler(accountId, ...args);
  };
}

const operationHandlers = {
  acceptFriendRequest: defer('acceptFriendRequest'),
  addGroupDeputy: defer('addGroupDeputy'),
  addReaction: defer('addReaction'),
  addUserToGroup: defer('addUserToGroup'),
  blockGroupMember: defer('blockGroupMember'),
  blockUser: defer('blockUser'),
  blockViewFeed: defer('blockViewFeed'),
  cancelFriendRequest: defer('cancelFriendRequest'),
  changeAccountAvatar: defer('changeAccountAvatar'),
  changeFriendAlias: defer('changeFriendAlias'),
  changeGroupAvatar: defer('changeGroupAvatar'),
  changeGroupOwner: defer('changeGroupOwner'),
  createGroup: defer('createGroup'),
  createPoll: defer('createPoll'),
  createReminder: defer('createReminder'),
  deleteMessage: defer('deleteMessage'),
  disableGroupLink: defer('disableGroupLink'),
  disperseGroup: defer('disperseGroup'),
  editMessage: defer('editMessage'),
  editReminder: defer('editReminder'),
  enableGroupLink: defer('enableGroupLink'),
  findUser: defer('findUser'),
  forwardMessage: defer('forwardMessage'),
  getAccountInfo: defer('getAccountInfo'),
  getAliasList: defer('getAliasList'),
  getAllFriends: defer('getAllFriends'),
  getAllGroups: defer('getAllGroups'),
  getFriendOnlines: defer('getFriendOnlines'),
  getFriendRecommendations: defer('getFriendRecommendations'),
  getFriendRequestStatus: defer('getFriendRequestStatus'),
  getGroupBlockedMembers: defer('getGroupBlockedMembers'),
  getGroupInfo: defer('getGroupInfo'),
  getGroupLinkDetail: defer('getGroupLinkDetail'),
  getGroupMembersInfo: defer('getGroupMembersInfo'),
  getLastOnline: defer('getLastOnline'),
  getOwnId: defer('getOwnId'),
  getPendingGroupMembers: defer('getPendingGroupMembers'),
  getPinConversations: defer('getPinConversations'),
  getPollDetail: defer('getPollDetail'),
  getSentFriendRequests: defer('getSentFriendRequests'),
  getUserInfo: defer('getUserInfo'),
  joinGroupByLink: defer('joinGroupByLink'),
  leaveGroup: defer('leaveGroup'),
  lockPoll: defer('lockPoll'),
  pinConversation: defer('pinConversation'),
  rejectFriendRequest: defer('rejectFriendRequest'),
  removeFriend: defer('removeFriend'),
  removeFriendAlias: defer('removeFriendAlias'),
  removeGroupDeputy: defer('removeGroupDeputy'),
  removeReminder: defer('removeReminder'),
  removeUserFromGroup: defer('removeUserFromGroup'),
  renameGroup: defer('renameGroup'),
  sendCard: defer('sendCard'),
  sendFile: defer('sendFile'),
  sendFriendRequest: defer('sendFriendRequest'),
  sendImage: defer('sendImage'),
  sendLink: defer('sendLink'),
  sendMessage: defer('sendMessage'),
  sendSticker: defer('sendSticker'),
  sendTypingEvent: defer('sendTypingEvent'),
  sendVideo: defer('sendVideo'),
  sendVoice: defer('sendVoice'),
  setOnlineStatus: defer('setOnlineStatus'),
  sharePoll: defer('sharePoll'),
  unblockGroupMember: defer('unblockGroupMember'),
  unblockUser: defer('unblockUser'),
  undoMessage: defer('undoMessage'),
  updateGroupSettings: defer('updateGroupSettings'),
  uploadAttachment: defer('uploadAttachment'),
  votePoll: defer('votePoll'),
} as unknown as Record<ProviderOperationName, ProviderOperation>;

async function readStoredCredentials(accountId: string) {
  const row = await prisma.zaloAccount.findUnique({
    where: { id: accountId },
    select: {
      sessionCiphertext: true,
      proxyCiphertext: true,
      sessionData: true,
      proxyUrl: true,
    },
  });
  if (!row) return null;
  if (!row.sessionCiphertext && !row.proxyCiphertext) {
    return { session: row.sessionData as any, proxyUrl: row.proxyUrl };
  }
  const key = process.env.ZALO_GATEWAY_CREDENTIAL_KEY || process.env.ENCRYPTION_KEY || '';
  const store = new GatewayCredentialStore({
    read: async () => row,
    write: async () => undefined,
  }, key);
  return store.read(accountId);
}

export async function runProviderCommand(command: ProviderCommandV1): Promise<unknown> {
  const args = command.payload.args;
  if (!Array.isArray(args)) {
    throw Object.assign(new Error('Provider command payload.args must be an array'), {
      code: 'INVALID_PARAMS',
      statusCode: 400,
    });
  }
  if (command.kind === 'loginWithQr') {
    const stored = await readStoredCredentials(command.accountId);
    void zaloPool.loginQR(command.accountId, stored?.proxyUrl ?? null).catch((err) => {
      logger.warn(`[zalo-gateway:${command.accountId}] QR login failed`, err);
    });
    return { started: true };
  }
  if (command.kind === 'reconnectAccount') {
    const stored = await readStoredCredentials(command.accountId);
    if (!stored?.session?.imei) {
      throw Object.assign(new Error('No saved session for reconnect'), {
        code: 'SESSION_EXPIRED',
        statusCode: 401,
      });
    }
    await zaloPool.reconnect(command.accountId, stored.session, stored.proxyUrl);
    return { connected: zaloPool.getStatus(command.accountId) === 'connected' };
  }
  if (command.kind === 'disconnectAccount') {
    zaloPool.disconnect(command.accountId);
    return { disconnected: true };
  }
  if (command.payload.executionPolicy === 'legacy_direct') {
    const instance = zaloPool.getInstance(command.accountId);
    if (!instance?.api || instance.status !== 'connected') {
      throw Object.assign(new Error('Zalo account not connected'), {
        code: 'NOT_CONNECTED',
        statusCode: 400,
      });
    }
    const api = instance.api;
    switch (command.kind) {
      case 'sendMessage': return api.sendMessage(args[0], args[1], args[2]);
      case 'getUserInfo': return api.getUserInfo(args[0]);
      case 'getAllFriends': return api.getAllFriends();
      case 'findUser': return api.findUser(args[0]);
      case 'uploadAttachment': return api.uploadAttachment(args[0], args[1], args[2]);
      case 'getAliasList': return api.getAliasList(args[0], args[1]);
      case 'getLabels': return api.getLabels();
      case 'updateLabels': return api.updateLabels(args[0]);
      case 'getStickers': return api.getStickers(args[0]);
      case 'getStickersDetail': return api.getStickersDetail(args[0]);
      case 'sendNativeVideo': return sendNativeVideo({ ...(args[0] as any), api });
      case 'backfillAccountHistory': return backfillAccountHistory(api, command.accountId);
      default: throw Object.assign(new Error(`Unsupported legacy-direct operation: ${command.kind}`), {
        code: 'INVALID_PARAMS',
        statusCode: 400,
      });
    }
  }
  return operationHandlers[command.kind](command.accountId, ...args);
}
