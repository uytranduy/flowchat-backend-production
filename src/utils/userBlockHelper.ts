import { Types } from "mongoose";
import UserBlock from "../models/UserBlock.js";

export interface UserBlockStatus {
  isBlocked: boolean;
  isBlockedByMe: boolean;
  hasBlockedMe: boolean;
}

export async function getUserBlockStatus(
  currentUserId: Types.ObjectId | string,
  otherUserId: Types.ObjectId | string
): Promise<UserBlockStatus> {
  const currentId = currentUserId.toString();
  const otherId = otherUserId.toString();

  if (currentId === otherId) {
    return {
      isBlocked: false,
      isBlockedByMe: false,
      hasBlockedMe: false,
    };
  }

  const relationships = await UserBlock.find({
    isActive: true,
    $or: [
      { blockerId: currentId, blockedId: otherId },
      { blockerId: otherId, blockedId: currentId },
    ],
  })
    .select("blockerId blockedId")
    .lean();

  const isBlockedByMe = relationships.some(
    (relationship) =>
      relationship.blockerId.toString() === currentId &&
      relationship.blockedId.toString() === otherId
  );
  const hasBlockedMe = relationships.some(
    (relationship) =>
      relationship.blockerId.toString() === otherId &&
      relationship.blockedId.toString() === currentId
  );

  return {
    isBlocked: isBlockedByMe || hasBlockedMe,
    isBlockedByMe,
    hasBlockedMe,
  };
}

export function blockedInteractionMessage(status: UserBlockStatus): string {
  return status.isBlockedByMe
    ? "Bạn đã chặn người dùng này"
    : "Bạn không thể tương tác trực tiếp với người dùng này";
}
