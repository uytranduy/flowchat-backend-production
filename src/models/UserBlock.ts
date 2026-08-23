import mongoose, { Schema, Types } from "mongoose";

export interface IUserBlock {
  blockerId: Types.ObjectId;
  blockedId: Types.ObjectId;
  isActive: boolean;
  blockedAt: Date;
  unblockedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const userBlockSchema = new Schema<IUserBlock>(
  {
    blockerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    blockedId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      required: true,
    },
    blockedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    unblockedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

// One durable relationship per direction. Unblock is a soft state change so
// the application never needs to delete an existing block record.
userBlockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
userBlockSchema.index({ blockerId: 1, isActive: 1, blockedAt: -1 });
userBlockSchema.index({ blockedId: 1, isActive: 1 });

const UserBlock = mongoose.model<IUserBlock>("UserBlock", userBlockSchema);

export default UserBlock;
