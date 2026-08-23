import mongoose, { Schema, Types } from "mongoose";

export type MessageType = "text" | "call" | "attachment" | "system";
export type CallMediaType = "audio" | "video";
export type CallType = "direct" | "group";
export type AttachmentKind = "image" | "video" | "file";
export type AttachmentResourceType = "image" | "video" | "raw";

export interface IMessageAttachment {
  kind: AttachmentKind;
  url: string;
  publicId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  resourceType: AttachmentResourceType;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

export interface ICallMessage {
  callId: string;
  callType: CallType;
  mediaType: CallMediaType;
  callerId: Types.ObjectId;
  calleeId?: Types.ObjectId;
  participantCount?: number;
  participants?: ICallParticipant[];
  reason: string;
  durationSeconds: number;
  startedAt: Date;
  acceptedAt?: Date;
  endedAt: Date;
}

export interface ICallParticipant {
  userId: Types.ObjectId;
  displayName: string;
  avatarUrl?: string;
  joinedAt: Date;
  leftAt: Date;
  durationSeconds: number;
  joinCount: number;
}

export interface IReplyToMessage {
  messageId: Types.ObjectId;
  senderId: Types.ObjectId;
  content?: string;
  messageType: MessageType;
  attachment?: Pick<IMessageAttachment, "kind" | "fileName">;
  isRecalled: boolean;
}

export interface IMessageReaction {
  userId: Types.ObjectId;
  emoji: string;
  createdAt: Date;
}

export interface IForwardedFrom {
  messageId: Types.ObjectId;
}

export interface IMessage {
  conversationId: Types.ObjectId;
  senderId: Types.ObjectId;
  content?: string;
  imgUrl?: string;
  messageType: MessageType;
  call?: ICallMessage;
  attachment?: IMessageAttachment;
  isRecalled: boolean;
  recalledAt?: Date;
  replyTo?: IReplyToMessage;
  reactions: IMessageReaction[];
  forwardedFrom?: IForwardedFrom;
  pinnedAt?: Date;
  pinnedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const attachmentSummarySchema = new Schema<
  Pick<IMessageAttachment, "kind" | "fileName">
>(
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

const messageAttachmentSchema = new Schema<IMessageAttachment>(
  {
    kind: {
      type: String,
      enum: ["image", "video", "file"],
      required: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
    publicId: {
      type: String,
      required: true,
      trim: true,
    },
    fileName: {
      type: String,
      required: true,
      trim: true,
    },
    mimeType: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    sizeBytes: {
      type: Number,
      required: true,
      min: 0,
    },
    resourceType: {
      type: String,
      enum: ["image", "video", "raw"],
      required: true,
    },
    width: {
      type: Number,
      min: 0,
    },
    height: {
      type: Number,
      min: 0,
    },
    durationSeconds: {
      type: Number,
      min: 0,
    },
  },
  { _id: false }
);

const callMessageSchema = new Schema<ICallMessage>(
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
      required: function (this: ICallMessage): boolean {
        return this.callType !== "group";
      },
    },
    participantCount: {
      type: Number,
      min: 1,
    },
    participants: {
      type: [
        new Schema<ICallParticipant>(
          {
            userId: {
              type: Schema.Types.ObjectId,
              ref: "User",
              required: true,
            },
            displayName: {
              type: String,
              required: true,
              trim: true,
            },
            avatarUrl: {
              type: String,
            },
            joinedAt: {
              type: Date,
              required: true,
            },
            leftAt: {
              type: Date,
              required: true,
            },
            durationSeconds: {
              type: Number,
              required: true,
              min: 0,
            },
            joinCount: {
              type: Number,
              required: true,
              min: 1,
            },
          },
          { _id: false }
        ),
      ],
      default: undefined,
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

const replyToMessageSchema = new Schema<IReplyToMessage>(
  {
    messageId: {
      type: Schema.Types.ObjectId,
      ref: "Message",
      required: true,
    },
    senderId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    content: {
      type: String,
    },
    messageType: {
      type: String,
      enum: ["text", "call", "attachment", "system"],
      required: true,
    },
    attachment: {
      type: attachmentSummarySchema,
    },
    isRecalled: {
      type: Boolean,
      default: false,
      required: true,
    },
  },
  { _id: false }
);

const messageReactionSchema = new Schema<IMessageReaction>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    emoji: {
      type: String,
      required: true,
      trim: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
  },
  { _id: false }
);

const forwardedFromSchema = new Schema<IForwardedFrom>(
  {
    messageId: {
      type: Schema.Types.ObjectId,
      ref: "Message",
      required: true,
    },
  },
  { _id: false }
);

const messageSchema = new Schema<IMessage>(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },
    senderId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    content: {
      type: String,
      trim: true,
    },
    imgUrl: {
      type: String,
    },
    messageType: {
      type: String,
      enum: ["text", "call", "attachment", "system"],
      default: "text",
      required: true,
    },
    call: {
      type: callMessageSchema,
      required: function (this: IMessage): boolean {
        return this.messageType === "call";
      },
    },
    attachment: {
      type: messageAttachmentSchema,
      required: function (this: IMessage): boolean {
        return this.messageType === "attachment" && !this.isRecalled;
      },
    },
    isRecalled: {
      type: Boolean,
      default: false,
      required: true,
    },
    recalledAt: {
      type: Date,
    },
    replyTo: {
      type: replyToMessageSchema,
    },
    reactions: {
      type: [messageReactionSchema],
      default: [],
    },
    forwardedFrom: {
      type: forwardedFromSchema,
    },
    pinnedAt: {
      type: Date,
    },
    pinnedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  }
);

messageSchema.index({ conversationId: 1, createdAt: -1 });
messageSchema.index({ conversationId: 1, pinnedAt: -1 });

const Message = mongoose.model<IMessage>("Message", messageSchema);
export default Message;
