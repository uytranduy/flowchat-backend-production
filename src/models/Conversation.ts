import mongoose, { Schema, Types } from "mongoose";
import type {
  AttachmentKind,
  CallMediaType,
  CallType,
  MessageType,
} from "./Message.js";

export interface IParticipant {
  userId: Types.ObjectId;
  joinedAt?: Date;
}

export interface IGroup {
  name?: string;
  createdBy?: Types.ObjectId;
  allowMembersToInvite?: boolean;
  allowMembersToRename?: boolean;
  dissolvedAt?: Date;
  dissolvedBy?: Types.ObjectId;
}

export interface ILastMessageCall {
  callId: string;
  callType: CallType;
  mediaType: CallMediaType;
  callerId: Types.ObjectId;
  calleeId?: Types.ObjectId;
  participantCount?: number;
  reason: string;
  durationSeconds: number;
  startedAt: Date;
  acceptedAt?: Date;
  endedAt: Date;
}

export interface ILastMessageAttachment {
  kind: AttachmentKind;
  fileName: string;
}

export interface ILastMessage {
  _id?: string;
  content?: string | null;
  senderId?: Types.ObjectId;
  createdAt?: Date | null;
  messageType?: MessageType;
  call?: ILastMessageCall;
  attachment?: ILastMessageAttachment;
  isRecalled?: boolean;
}

export interface IConversation {
  type: "direct" | "group";
  participants: IParticipant[];
  group?: IGroup;
  lastMessageAt?: Date;
  seenBy: Types.ObjectId[];
  lastMessage?: ILastMessage | null;
  unreadCounts: Map<string, number>;
  hiddenFor: Types.ObjectId[];
  createdAt?: Date;
  updatedAt?: Date;
}

const participantSchema = new Schema<IParticipant>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    _id: false,
  }
);

const groupSchema = new Schema<IGroup>(
  {
    name: {
      type: String,
      trim: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    allowMembersToInvite: {
      type: Boolean,
      default: true,
    },
    allowMembersToRename: {
      type: Boolean,
      default: true,
    },
    dissolvedAt: {
      type: Date,
    },
    dissolvedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    _id: false,
  }
);

const lastMessageCallSchema = new Schema<ILastMessageCall>(
  {
    callId: {
      type: String,
      required: true,
      trim: true,
    },
    callType: {
      type: String,
      enum: ["direct", "group"],
      default: "direct",
      required: true,
    },
    mediaType: {
      type: String,
      enum: ["audio", "video"],
      required: true,
    },
    callerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    calleeId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: function (this: ILastMessageCall): boolean {
        return this.callType !== "group";
      },
    },
    participantCount: {
      type: Number,
      min: 1,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
    },
    durationSeconds: {
      type: Number,
      required: true,
      min: 0,
    },
    startedAt: {
      type: Date,
      required: true,
    },
    acceptedAt: {
      type: Date,
    },
    endedAt: {
      type: Date,
      required: true,
    },
  },
  { _id: false }
);

const lastMessageAttachmentSchema = new Schema<ILastMessageAttachment>(
  {
    kind: {
      type: String,
      enum: ["image", "video", "file"],
      required: true,
    },
    fileName: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { _id: false }
);

const lastMessageSchema = new Schema<ILastMessage>(
  {
    _id: { type: String },
    content: {
      type: String,
      default: null,
    },
    senderId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    createdAt: {
      type: Date,
      default: null,
    },
    messageType: {
      type: String,
      enum: ["text", "call", "attachment", "system"],
    },
    call: {
      type: lastMessageCallSchema,
    },
    attachment: {
      type: lastMessageAttachmentSchema,
    },
    isRecalled: {
      type: Boolean,
      default: false,
    },
  },
  {
    _id: false,
  }
);

const conversationSchema = new Schema<IConversation>(
  {
    type: {
      type: String,
      enum: ["direct", "group"],
      required: true,
    },
    participants: {
      type: [participantSchema],
      required: true,
    },
    group: {
      type: groupSchema,
    },
    lastMessageAt: {
      type: Date,
    },
    seenBy: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    lastMessage: {
      type: lastMessageSchema,
      default: null,
    },
    unreadCounts: {
      type: Map,
      of: Number,
      default: {},
    },
    hiddenFor: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
  },
  {
    timestamps: true,
  }
);

// We keep the exact index from the original file (which contains the participant typo/behavior)
conversationSchema.index({
  "participant.userId": 1,
  lastMessageAt: -1,
});

const Conversation = mongoose.model<IConversation>("Conversation", conversationSchema);
export default Conversation;
