import mongoose, { Schema, Types } from "mongoose";

export interface IFriend {
  userA: Types.ObjectId;
  userB: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const friendSchema = new Schema<IFriend>(
  {
    userA: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    userB: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

friendSchema.pre("save", function (this: any, next) {
  const a = this.userA.toString();
  const b = this.userB.toString();

  if (a > b) {
    this.userA = new mongoose.Types.ObjectId(b);
    this.userB = new mongoose.Types.ObjectId(a);
  }

  next();
});

friendSchema.index({ userA: 1, userB: 1 }, { unique: true });

const Friend = mongoose.model<IFriend>("Friend", friendSchema);

export default Friend;
