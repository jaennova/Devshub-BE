import { Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '../common/errors';
import { Prisma, NotificationType } from '../generated/prisma/client';
import { FeedGateway } from '../realtime/feed.gateway';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';

const previewText = (s: string, max = 200) => {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
};

const listInclude = {
  actor: { select: { id: true, username: true, photoKey: true, isAdmin: true } as const },
  post: { select: { id: true, title: true, isDraft: true } as const },
  comment: { select: { id: true, postId: true, body: true } as const },
  discussion: { select: { id: true, title: true, isDraft: true } as const },
  discussionComment: { select: { id: true, discussionId: true, body: true } as const },
} as const;

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly feedGateway: FeedGateway,
    private readonly mailService: MailService,
  ) {}

  private async withActorFollowInfo<T extends { actorId: string | null; actor?: unknown }>(
    viewerId: string,
    rows: T[],
  ) {
    const actorIds = Array.from(
      new Set(rows.map((r) => r.actorId).filter((id): id is string => typeof id === 'string' && id.length > 0)),
    );
    if (actorIds.length === 0) {
      return rows.map((r) => ({
        ...r,
        actor:
          r.actor && typeof r.actor === 'object'
            ? ({
                ...(r.actor as Record<string, unknown>),
                isFollowedByViewer: false,
                isFollowingViewer: false,
              } as unknown)
            : r.actor,
      }));
    }

    const [viewerFollows, actorFollowsViewer] = await this.prisma.$transaction([
      this.prisma.follow.findMany({
        where: { followerId: viewerId, followingId: { in: actorIds } },
        select: { followingId: true },
      }),
      this.prisma.follow.findMany({
        where: { followerId: { in: actorIds }, followingId: viewerId },
        select: { followerId: true },
      }),
    ]);
    const followedByViewer = new Set(viewerFollows.map((f) => f.followingId));
    const followingViewer = new Set(actorFollowsViewer.map((f) => f.followerId));

    return rows.map((r) => {
      const actorId = typeof r.actorId === 'string' && r.actorId.length > 0 ? r.actorId : null;
      const isFollowedByViewer = actorId ? followedByViewer.has(actorId) : false;
      const isFollowingViewer = actorId ? followingViewer.has(actorId) : false;
      return {
        ...r,
        actor:
          r.actor && typeof r.actor === 'object'
            ? ({ ...(r.actor as Record<string, unknown>), isFollowedByViewer, isFollowingViewer } as unknown)
            : r.actor,
      };
    });
  }

  async list(userId: string, unreadOnly: boolean, limit: number, offset: number) {
    const where: Prisma.NotificationWhereInput = { userId, ...(unreadOnly ? { read: false } : {}) };
    const [rows, total, unreadCount] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: listInclude,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, read: false } }),
    ]);
    const enriched = await this.withActorFollowInfo(userId, rows);
    return {
      data: enriched,
      total,
      unreadCount,
      limit,
      offset,
    };
  }

  async getUnreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, read: false },
    });
    return { unreadCount: count };
  }

  async markAsRead(userId: string, notificationId: string) {
    const n = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
    });
    if (!n) {
      AppError.notFound(ErrorCode.NOTIFICATION_NOT_FOUND, 'Notificación no encontrada');
    }
    if (n.read) {
      return n;
    }
    const updated = await this.prisma.notification.update({
      where: { id: notificationId },
      data: { read: true, readAt: new Date() },
      include: listInclude,
    });
    const [enriched] = await this.withActorFollowInfo(userId, [updated]);
    const unreadCount = await this.prisma.notification.count({
      where: { userId, read: false },
    });
    this.feedGateway.emitNotificationUpdated(userId, enriched);
    this.feedGateway.emitNotificationsUnread(userId, unreadCount);
    return enriched;
  }

  async markAllAsRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true, readAt: new Date() },
    });
    if (result.count > 0) {
      this.feedGateway.emitNotificationsUnread(userId, 0);
    }
    return { updated: result.count };
  }

  // ——— Disparadores (llamados desde posts / users / discussions) ———

  private async actorUsername(userId: string) {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true, isAdmin: true },
    });
    return u?.username ?? 'usuario';
  }

  private async create(data: {
    userId: string;
    actorId: string | null;
    type: NotificationType;
    title: string;
    preview: string | null;
    postId?: string | null;
    commentId?: string | null;
    discussionId?: string | null;
    discussionCommentId?: string | null;
    metadata?: Prisma.InputJsonValue;
  }) {
    if (data.userId === data.actorId) {
      return;
    }
    const row = await this.prisma.notification.create({
      data: {
        userId: data.userId,
        actorId: data.actorId,
        type: data.type,
        title: data.title,
        preview: data.preview,
        postId: data.postId ?? undefined,
        commentId: data.commentId ?? undefined,
        discussionId: data.discussionId ?? undefined,
        discussionCommentId: data.discussionCommentId ?? undefined,
        metadata: data.metadata,
      },
      include: listInclude,
    });
    const [enriched] = await this.withActorFollowInfo(data.userId, [row]);
    const unreadCount = await this.prisma.notification.count({
      where: { userId: data.userId, read: false },
    });
    this.feedGateway.emitNotificationCreated(data.userId, enriched);
    this.feedGateway.emitNotificationsUnread(data.userId, unreadCount);
  }

  async onNewFollower(recipientId: string, actorId: string) {
    if (recipientId === actorId) return;
    const name = await this.actorUsername(actorId);
    await this.create({
      userId: recipientId,
      actorId,
      type: 'NEW_FOLLOWER',
      title: `${name} comenzó a seguirte`,
      preview: null,
    });
  }

  async onCommentOnPost(args: {
    postAuthorId: string;
    commentAuthorId: string;
    postId: string;
    postTitle: string;
    commentId: string;
    body: string;
  }) {
    if (args.postAuthorId === args.commentAuthorId) return;
    const name = await this.actorUsername(args.commentAuthorId);
    await this.create({
      userId: args.postAuthorId,
      actorId: args.commentAuthorId,
      type: 'COMMENT_ON_YOUR_POST',
      title: `${name} comentó en tu publicación`,
      preview: previewText(args.body),
      postId: args.postId,
      commentId: args.commentId,
    });
  }

  async onMentionsInPostComment(args: {
    body: string;
    commentAuthorId: string;
    postId: string;
    postTitle: string;
    commentId: string;
    postAuthorId: string;
  }) {
    const re = /@([a-zA-Z0-9_]+)/g;
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    const usernames: string[] = [];
    while ((m = re.exec(args.body)) !== null) {
      const u = m[1];
      if (seen.has(u)) continue;
      seen.add(u);
      usernames.push(u);
      if (usernames.length > 20) break;
    }
    if (usernames.length === 0) return;
    const users = await this.prisma.user.findMany({
      where: { username: { in: usernames } },
      select: { id: true, username: true, email: true },
    });
    const name = await this.actorUsername(args.commentAuthorId);
    const appUrl = process.env.APP_URL || 'https://devshub.dev';
    const linkUrl = `${appUrl}/posts/${args.postId}?comment=${args.commentId}`;
    for (const u of users) {
      if (u.id === args.commentAuthorId) continue;
      if (u.id === args.postAuthorId) continue;
      await this.create({
        userId: u.id,
        actorId: args.commentAuthorId,
        type: 'MENTION',
        title: `${name} te mencionó en un comentario`,
        preview: previewText(args.body),
        postId: args.postId,
        commentId: args.commentId,
        metadata: { postTitle: args.postTitle },
      });
      this.mailService.sendMentionEmail({
        toEmail: u.email,
        toUsername: u.username,
        fromUsername: name,
        mentionType: 'post_comment',
        preview: previewText(args.body),
        linkUrl,
      }).catch(() => {});
    }
  }

  async onLikeOnPost(postAuthorId: string, likerId: string, postId: string, postTitle: string) {
    if (postAuthorId === likerId) return;
    const name = await this.actorUsername(likerId);
    await this.create({
      userId: postAuthorId,
      actorId: likerId,
      type: 'LIKE_ON_YOUR_POST',
      title: `A ${name} le gustó tu publicación`,
      preview: postTitle,
      postId,
    });
  }

  async onCommentOnDiscussion(args: {
    discussionAuthorId: string;
    commentAuthorId: string;
    discussionId: string;
    discussionTitle: string;
    commentId: string;
    body: string;
  }) {
    if (args.discussionAuthorId === args.commentAuthorId) return;
    const name = await this.actorUsername(args.commentAuthorId);
    await this.create({
      userId: args.discussionAuthorId,
      actorId: args.commentAuthorId,
      type: 'COMMENT_ON_YOUR_DISCUSSION',
      title: `${name} comentó en tu discusión`,
      preview: previewText(args.body),
      discussionId: args.discussionId,
      discussionCommentId: args.commentId,
    });
  }

  async onMentionsInDiscussionComment(args: {
    body: string;
    commentAuthorId: string;
    discussionId: string;
    discussionTitle: string;
    commentId: string;
    discussionAuthorId: string;
  }) {
    const re = /@([a-zA-Z0-9_]+)/g;
    const seen = new Set<string>();
    const usernames: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(args.body)) !== null) {
      const u = m[1];
      if (seen.has(u)) continue;
      seen.add(u);
      usernames.push(u);
      if (usernames.length > 20) break;
    }
    if (usernames.length === 0) return;
    const users = await this.prisma.user.findMany({
      where: { username: { in: usernames } },
      select: { id: true },
    });
    const name = await this.actorUsername(args.commentAuthorId);
    for (const u of users) {
      if (u.id === args.commentAuthorId) continue;
      if (u.id === args.discussionAuthorId) continue;
      await this.create({
        userId: u.id,
        actorId: args.commentAuthorId,
        type: 'MENTION',
        title: `${name} te mencionó en un comentario`,
        preview: previewText(args.body),
        discussionId: args.discussionId,
        discussionCommentId: args.commentId,
        metadata: { discussionTitle: args.discussionTitle },
      });
    }
  }

  async onLikeOnDiscussion(discussionAuthorId: string, likerId: string, discussionId: string, title: string) {
    if (discussionAuthorId === likerId) return;
    const name = await this.actorUsername(likerId);
    await this.create({
      userId: discussionAuthorId,
      actorId: likerId,
      type: 'LIKE_ON_YOUR_DISCUSSION',
      title: `A ${name} le gustó tu discusión`,
      preview: title,
      discussionId,
    });
  }

  async onLikeOnYourPostComment(args: {
    commentAuthorId: string;
    likerId: string;
    postId: string;
    commentId: string;
    previewBody: string;
  }) {
    if (args.commentAuthorId === args.likerId) return;
    const name = await this.actorUsername(args.likerId);
    await this.create({
      userId: args.commentAuthorId,
      actorId: args.likerId,
      type: 'LIKE_ON_YOUR_POST_COMMENT',
      title: `A ${name} le gustó tu comentario`,
      preview: previewText(args.previewBody),
      postId: args.postId,
      commentId: args.commentId,
    });
  }

  async onReplyToYourPostComment(args: {
    parentAuthorId: string;
    replyAuthorId: string;
    postId: string;
    postTitle: string;
    replyCommentId: string;
    parentCommentId: string;
    body: string;
  }) {
    if (args.parentAuthorId === args.replyAuthorId) return;
    const name = await this.actorUsername(args.replyAuthorId);
    await this.create({
      userId: args.parentAuthorId,
      actorId: args.replyAuthorId,
      type: 'REPLY_TO_YOUR_POST_COMMENT',
      title: `${name} respondió tu comentario`,
      preview: previewText(args.body),
      postId: args.postId,
      commentId: args.replyCommentId,
      metadata: { postTitle: args.postTitle, parentCommentId: args.parentCommentId },
    });
  }

  async onLikeOnYourDiscussionComment(args: {
    commentAuthorId: string;
    likerId: string;
    discussionId: string;
    commentId: string;
    previewBody: string;
  }) {
    if (args.commentAuthorId === args.likerId) return;
    const name = await this.actorUsername(args.likerId);
    await this.create({
      userId: args.commentAuthorId,
      actorId: args.likerId,
      type: 'LIKE_ON_YOUR_DISCUSSION_COMMENT',
      title: `A ${name} le gustó tu comentario`,
      preview: previewText(args.previewBody),
      discussionId: args.discussionId,
      discussionCommentId: args.commentId,
    });
  }

  async onReplyToYourDiscussionComment(args: {
    parentAuthorId: string;
    replyAuthorId: string;
    discussionId: string;
    discussionTitle: string;
    replyCommentId: string;
    parentCommentId: string;
    body: string;
  }) {
    if (args.parentAuthorId === args.replyAuthorId) return;
    const name = await this.actorUsername(args.replyAuthorId);
    await this.create({
      userId: args.parentAuthorId,
      actorId: args.replyAuthorId,
      type: 'REPLY_TO_YOUR_DISCUSSION_COMMENT',
      title: `${name} respondió tu comentario`,
      preview: previewText(args.body),
      discussionId: args.discussionId,
      discussionCommentId: args.replyCommentId,
      metadata: { discussionTitle: args.discussionTitle, parentCommentId: args.parentCommentId },
    });
  }
}
