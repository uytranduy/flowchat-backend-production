import mongoose, { Schema, Types } from "mongoose";

export interface IFriendRequest {
  from: Types.ObjectId;
  to: Types.ObjectId;
  message?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const friendRequestSchema = new Schema<IFriendRequest>(
  {
    from: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    to: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    message: {
      type: String,
      maxlength: 300,
    },
  },
  {
    timestamps: true,
  }
);

friendRequestSchema.index({ from: 1, to: 1 }, { unique: true });
friendRequestSchema.index({ from: 1 });
friendRequestSchema.index({ to: 1 });

const FriendRequest = mongoose.model<IFriendRequest>("FriendRequest", friendRequestSchema);
export default FriendRequest;
