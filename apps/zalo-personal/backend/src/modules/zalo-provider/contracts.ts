import { z } from 'zod';

export const providerOperationNames = [
  'acceptFriendRequest',
  'addGroupDeputy',
  'addReaction',
  'addUserToGroup',
  'backfillAccountHistory',
  'blockGroupMember',
  'blockUser',
  'blockViewFeed',
  'cancelFriendRequest',
  'changeAccountAvatar',
  'changeFriendAlias',
  'changeGroupAvatar',
  'changeGroupOwner',
  'createGroup',
  'createPoll',
  'createReminder',
  'deleteMessage',
  'disconnectAccount',
  'disableGroupLink',
  'disperseGroup',
  'editMessage',
  'editReminder',
  'enableGroupLink',
  'findUser',
  'forwardMessage',
  'getAccountInfo',
  'getAliasList',
  'getAllFriends',
  'getAllGroups',
  'getFriendOnlines',
  'getFriendRecommendations',
  'getFriendRequestStatus',
  'getGroupBlockedMembers',
  'getGroupInfo',
  'getGroupLinkDetail',
  'getGroupMembersInfo',
  'getLabels',
  'getLastOnline',
  'getOwnId',
  'getPendingGroupMembers',
  'getPinConversations',
  'getPollDetail',
  'getSentFriendRequests',
  'getStickers',
  'getStickersDetail',
  'getUserInfo',
  'joinGroupByLink',
  'leaveGroup',
  'loginWithQr',
  'lockPoll',
  'pinConversation',
  'rejectFriendRequest',
  'reconnectAccount',
  'removeFriend',
  'removeFriendAlias',
  'removeGroupDeputy',
  'removeReminder',
  'removeUserFromGroup',
  'renameGroup',
  'sendCard',
  'sendFile',
  'sendFriendRequest',
  'sendImage',
  'sendLink',
  'sendMessage',
  'sendNativeVideo',
  'sendSticker',
  'sendTypingEvent',
  'sendVideo',
  'sendVoice',
  'setOnlineStatus',
  'sharePoll',
  'unblockGroupMember',
  'unblockUser',
  'undoMessage',
  'updateGroupSettings',
  'updateLabels',
  'uploadAttachment',
  'votePoll',
] as const;

export const providerOperationNameSchema = z.enum(providerOperationNames);

const isoDateTime = z.string().datetime({ offset: true });
const nonEmptyId = z.string().min(1).max(256);

export const providerCommandSchema = z.object({
  version: z.literal(1),
  commandId: nonEmptyId,
  idempotencyKey: nonEmptyId,
  accountId: nonEmptyId,
  kind: providerOperationNameSchema,
  payload: z.record(z.string(), z.unknown()),
  requestedAt: isoDateTime,
  deadlineAt: isoDateTime,
  traceId: nonEmptyId,
}).strict();

export const providerResultSchema = z.object({
  version: z.literal(1),
  commandId: nonEmptyId,
  status: z.enum(['succeeded', 'rejected', 'failed', 'unknown_outcome']),
  providerIds: z.record(z.string(), z.string()).default({}),
  errorCode: z.string().min(1).optional(),
  retryable: z.boolean().default(false),
  payload: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const providerEventSchema = z.object({
  version: z.literal(1),
  eventId: nonEmptyId,
  accountId: nonEmptyId,
  accountSequence: z.number().int().positive(),
  kind: z.enum([
    'account_status',
    'delivered',
    'friend',
    'group',
    'message',
    'reaction',
    'seen',
    'typing',
    'undo',
  ]),
  occurredAt: isoDateTime,
  providerIds: z.record(z.string(), z.string()).default({}),
  payload: z.record(z.string(), z.unknown()),
}).strict();

export const providerAccountStatusSchema = z.object({
  version: z.literal(1),
  accountId: nonEmptyId,
  status: z.enum(['connected', 'connecting', 'disconnected', 'qr_pending']),
  reason: z.string().min(1).optional(),
}).strict();

export type ProviderCommandV1 = z.infer<typeof providerCommandSchema>;
export type ProviderResultV1 = z.infer<typeof providerResultSchema>;
export type ProviderEventV1 = z.infer<typeof providerEventSchema>;
export type ProviderAccountStatusV1 = z.infer<typeof providerAccountStatusSchema>;
export type ProviderOperationName = z.infer<typeof providerOperationNameSchema>;
