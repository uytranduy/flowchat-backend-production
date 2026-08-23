import { HydratedDocument } from "mongoose";
import { IMessage } from "../models/Message.js";
import User from "../models/User.js";

export async function presentMessagesWithReactionUsers(
  messages: ReadonlyArray<HydratedDocument<IMessage>>
): Promise<Array<Record<string, unknown>>> {
  const reactionUserIds = Array.from(
    new Set(
      messages.flatMap((message) =>
        message.reactions.map((reaction) => reaction.userId.toString())
      )
    )
  );

  const users = reactionUserIds.length
    ? await User.find({ _id: { $in: reactionUserIds } })
        .select("_id displayName username avatarUrl")
        .lean()
    : [];
  const usersById = new Map(users.map((user) => [user._id.toString(), user]));

  return messages.map((message) => {
    const presented = message.toObject();
    return {
      ...presented,
      // Always include nullable pin fields. Clients merge realtime message
      // updates, so omitting these keys would preserve a stale pinned state.
      pinnedAt: presented.pinnedAt ?? null,
      pinnedBy: presented.pinnedBy ?? null,
      reactions: message.reactions.map((reaction) => ({
        userId: reaction.userId,
        emoji: reaction.emoji,
        createdAt: reaction.createdAt,
        user: usersById.get(reaction.userId.toString()) ?? null,
      })),
    };
  });
}

export async function presentMessageWithReactionUsers(
  message: HydratedDocument<IMessage>
): Promise<Record<string, unknown>> {
  const [presented] = await presentMessagesWithReactionUsers([message]);
  return presented;
}
