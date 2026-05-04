import { Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '../common/errors';
import { Prisma } from '../generated/prisma/client';
import { randomBytes } from 'crypto';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../storage/s3.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { TrendingBuildersBy, TrendingBuildersQueryDto } from './dto/trending-builders-query.dto';

const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Elegibilidad: seguidores totales > 10 y/o algún post público con más de 10 likes en ese post. */
const TRENDING_MIN_FOLLOWERS_EXCLUSIVE = 10;
const TRENDING_MIN_LIKES_ON_A_POST_EXCLUSIVE = 10;

/** Prefijo bajo el bucket (`S3_USERS_FOLDER`; por defecto `profile-media/`). */
function s3ProfileMediaKeyPrefix(): string {
  const raw = process.env.S3_USERS_FOLDER?.trim().replace(/^\//, '');
  if (!raw) {
    return 'profile-media/';
  }
  return raw.endsWith('/') ? raw : `${raw}/`;
}

type TrendingBuilder = {
  id: string;
  username: string;
  photoKey: string | null;
  position: string | null;
  description: string | null;
  followersCount: number;
  likesReceivedCount: number;
  score: number;
};

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly notifications: NotificationsService,
  ) {}

  async getMyProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        photoKey: true,
        position: true,
        description: true,
        techStack: true,
        socialLinks: true,
        websiteUrl: true,
        isVerified: true,
        isAdmin: true,
        createdAt: true,
        _count: {
          select: {
            followers: true,
            following: true,
            posts: true,
          },
        },
      },
    });

    if (!user) AppError.notFound(ErrorCode.USER_NOT_FOUND, 'User not found');

    return user;
  }

  async getMyProfileWithBookmarks(userId: string) {
    const profile = await this.getMyProfile(userId);

    const bookmarks = await this.prisma.bookmark.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: {
        createdAt: true,
        post: {
          include: {
            author: {
              select: { id: true, username: true, photoKey: true, isAdmin: true },
            },
            _count: {
              select: { likes: true, bookmarks: true },
            },
          },
        },
      },
    });

    return {
      ...profile,
      bookmarks,
    };
  }

  async getMyFollowCounts(userId: string) {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        _count: {
          select: { followers: true, following: true },
        },
      },
    });
    if (!row) {
      AppError.notFound(ErrorCode.USER_NOT_FOUND, 'User not found');
    }
    return {
      followersCount: row._count.followers,
      followingCount: row._count.following,
    };
  }

  async followUser(followerId: string, targetUsername: string) {
    const uname = targetUsername.trim();
    if (!uname) {
      AppError.badRequest(ErrorCode.USER_USERNAME_INVALID, 'username invalido');
    }
    const target = await this.prisma.user.findUnique({
      where: { username: uname },
      select: { id: true, isActive: true, username: true },
    });
    if (!target?.isActive) {
      AppError.notFound(ErrorCode.USER_NOT_FOUND, 'User not found');
    }
    if (target.id === followerId) {
      AppError.badRequest(ErrorCode.USER_CANNOT_FOLLOW_SELF, 'No puedes seguirte a ti mismo');
    }
    const hadFollow = await this.prisma.follow.findUnique({
      where: {
        followerId_followingId: {
          followerId,
          followingId: target.id,
        },
      },
    });
    await this.prisma.follow.upsert({
      where: {
        followerId_followingId: {
          followerId,
          followingId: target.id,
        },
      },
      update: {},
      create: {
        followerId,
        followingId: target.id,
      },
    });
    if (!hadFollow) {
      await this.notifications.onNewFollower(target.id, followerId).catch(() => undefined);
    }
    return { following: true, username: target.username };
  }

  async unfollowUser(followerId: string, targetUsername: string) {
    const uname = targetUsername.trim();
    if (!uname) {
      AppError.badRequest(ErrorCode.USER_USERNAME_INVALID, 'username invalido');
    }
    const target = await this.prisma.user.findUnique({
      where: { username: uname },
      select: { id: true, username: true },
    });
    if (!target) {
      AppError.notFound(ErrorCode.USER_NOT_FOUND, 'User not found');
    }
    if (target.id === followerId) {
      AppError.badRequest(ErrorCode.USER_INVALID_OPERATION, 'Operación no válida');
    }
    await this.prisma.follow.deleteMany({
      where: { followerId, followingId: target.id },
    });
    return { following: false, username: target.username };
  }

  /**
   * this function returns the followers of the user
   * @param userId the id of the user
   * @returns 
   */
  async getMyFollowers(userId: string) {
    return await this.prisma.follow.findMany({
     where: { followingId: userId },
     select: { follower: { select: { id: true, username: true, photoKey: true, isAdmin: true } } },
   });
 }

  /**
   * this function returns the following of the user
   * @param userId the id of the user
   * @returns 
   */
  async getMyFollowing(userId: string) {
    return await this.prisma.user.findMany({
      where: { followers: { some: { followerId: userId } } },
      select: { id: true, username: true, photoKey: true, isAdmin: true },
    });
  }

  async getProfileByUsername(username: string, viewerId: string) {
    const user = await this.prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        username: true,
        photoKey: true,
        position: true,
        description: true,
        techStack: true,
        socialLinks: true,
        websiteUrl: true,
        isAdmin: true,
        createdAt: true,
        _count: {
          select: {
            followers: true,
            following: true,
            posts: true,
          },
        },
      },
    });

    if (!user) AppError.notFound(ErrorCode.USER_NOT_FOUND, 'User not found');

    let isFollowedByViewer = false;
    if (viewerId !== user.id) {
      const follow = await this.prisma.follow.findUnique({
        where: {
          followerId_followingId: { followerId: viewerId, followingId: user.id },
        },
        select: { followerId: true },
      });
      isFollowedByViewer = !!follow;
    }

    return {
      ...user,
      postsCount: user._count.posts,
      isFollowedByViewer,
    };
  }

  async updateMyProfile(
    userId: string,
    dto: UpdateProfileDto,
    file?: Express.Multer.File,
  ) {
    const techList = dto.techStack ?? dto.techStacks;

    const hasText =
      dto.position !== undefined ||
      dto.description !== undefined ||
      dto.websiteUrl !== undefined ||
      techList !== undefined ||
      dto.socialLinks !== undefined ||
      dto.username !== undefined;

    if (!file && !hasText) {
      AppError.badRequest(
        ErrorCode.USER_PROFILE_NOTHING_TO_UPDATE,
        'Nada que actualizar: envia al menos un campo o un archivo de foto',
      );
    }

    const existing = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, photoKey: true, username: true },
    });
    if (!existing) AppError.notFound(ErrorCode.USER_NOT_FOUND, 'User not found');

    if (dto.username !== undefined) {
      const next = dto.username.trim();
      if (next !== existing.username) {
        const taken = await this.prisma.user.findFirst({
          where: { username: next, NOT: { id: userId } },
          select: { id: true },
        });
        if (taken) {
          AppError.conflict(ErrorCode.USER_USERNAME_IN_USE, 'Ese nombre de usuario ya está en uso');
        }
      }
    }

    let publicPhotoToStore: string | undefined;
    if (file) {
      if (!ALLOWED_IMAGE_MIME.has(file.mimetype)) {
        AppError.badRequest(
          ErrorCode.USER_PROFILE_IMAGE_TYPE_INVALID,
          'Tipo de imagen no permitido (usa JPEG, PNG, GIF o WebP)',
        );
      }
      const ext = this.extensionForImage(file.mimetype, file.originalname);
      const s3ObjectKey = `${s3ProfileMediaKeyPrefix()}${userId}/${Date.now()}-${randomBytes(8).toString('hex')}${ext}`;
      await this.s3.putObject({
        key: s3ObjectKey,
        body: file.buffer,
        contentType: file.mimetype,
        acl: S3Service.publicObjectWriteAcl(),
      });
      publicPhotoToStore = S3Service.publicUrlForObjectKey(s3ObjectKey);
    }

    const data: Prisma.UserUpdateInput = {};
    if (dto.position !== undefined) data.position = dto.position;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.websiteUrl !== undefined) data.websiteUrl = dto.websiteUrl;
    if (techList !== undefined) data.techStack = { set: techList };
    if (dto.socialLinks !== undefined) data.socialLinks = dto.socialLinks as Prisma.InputJsonValue;
    if (dto.username !== undefined) data.username = dto.username.trim();
    if (publicPhotoToStore !== undefined) data.photoKey = publicPhotoToStore;

    if (Object.keys(data).length === 0) {
      AppError.badRequest(
        ErrorCode.USER_PROFILE_NOTHING_TO_UPDATE,
        'Nada que actualizar: envia al menos un campo o un archivo de foto',
      );
    }

    await this.prisma.user.update({
      where: { id: userId },
      data,
    });

    if (file && publicPhotoToStore) {
      const toDelete = S3Service.objectKeyFromStoredUserPhoto(existing.photoKey);
      if (toDelete) {
        void this.s3.deleteObjectBestEffort({ key: toDelete });
      }
    }

    return this.getMyProfileWithBookmarks(userId);
  }

  private extensionForImage(mimetype: string, originalname: string): string {
    const byMime: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
    };
    if (byMime[mimetype]) return byMime[mimetype];
    const fromName = originalname?.match(/(\.[a-zA-Z0-9]+)$/);
    return fromName?.[1] ?? '.bin';
  }

  async getTrendingBuilders(query: TrendingBuildersQueryDto, viewerUserId?: string) {
    const by = query.by ?? TrendingBuildersBy.COMBINED;
    const limit = query.limit ?? 10;

    const users = await this.prisma.user.findMany({
      where: { isActive: true },
      select: {
        id: true,
        username: true,
        photoKey: true,
        position: true,
        description: true,
        _count: {
          select: {
            followers: true,
          },
        },
      },
    });

    const postLikes = await this.prisma.post.findMany({
      where: { isDraft: false },
      select: {
        authorId: true,
        _count: {
          select: {
            likes: true,
          },
        },
      },
    });

    const likesByAuthor = postLikes.reduce<Record<string, number>>((acc, post) => {
      acc[post.authorId] = (acc[post.authorId] ?? 0) + post._count.likes;
      return acc;
    }, {});

    const maxLikesOnOnePostByAuthor = postLikes.reduce<Record<string, number>>((acc, post) => {
      const n = post._count.likes;
      const prev = acc[post.authorId] ?? 0;
      acc[post.authorId] = Math.max(prev, n);
      return acc;
    }, {});

    const builders: TrendingBuilder[] = users.map((user) => {
      const followersCount = user._count.followers;
      const likesReceivedCount = likesByAuthor[user.id] ?? 0;
      const score =
        by === TrendingBuildersBy.FOLLOWERS
          ? followersCount
          : by === TrendingBuildersBy.LIKES
            ? likesReceivedCount
            : followersCount + likesReceivedCount;

      return {
        id: user.id,
        username: user.username,
        photoKey: user.photoKey,
        position: user.position,
        description: user.description,
        followersCount,
        likesReceivedCount,
        score
      };
    });

    const eligible = builders.filter((b) => {
      const followersOk = b.followersCount > TRENDING_MIN_FOLLOWERS_EXCLUSIVE;
      const anyPostEnoughLikes =
        (maxLikesOnOnePostByAuthor[b.id] ?? 0) > TRENDING_MIN_LIKES_ON_A_POST_EXCLUSIVE;
      return followersOk || anyPostEnoughLikes;
    });

    const trending = eligible
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.followersCount !== a.followersCount) return b.followersCount - a.followersCount;
        return b.likesReceivedCount - a.likesReceivedCount;
      })
      .slice(0, limit);

    let followedIds = new Set<string>();
    if (viewerUserId && trending.length > 0) {
      const rows = await this.prisma.follow.findMany({
        where: {
          followerId: viewerUserId,
          followingId: { in: trending.map((t) => t.id) },
        },
        select: { followingId: true },
      });
      followedIds = new Set(rows.map((r) => r.followingId));
    }

    const items: TrendingBuilder[] = trending.map((row) => ({
      ...row,
      isFollowedByViewer: viewerUserId ? followedIds.has(row.id) : false,
    }));

    return {
      by,
      limit,
      totalCandidates: eligible.length,
      items,
    };
  }

  async getUsernames(): Promise<{ data: string[] }> {
    const users = await this.prisma.user.findMany({
      where: { isActive: true },
      select: { username: true },
      orderBy: { username: 'asc' },
    });
    return { data: users.map((u) => u.username) };
  }

  async searchUsernames(query: string): Promise<{ data: string[] }> {
    const q = query.trim();
    if (q.length < 3) {
      return { data: [] };
    }
    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        username: { contains: q, mode: 'insensitive' },
      },
      select: { username: true },
      orderBy: { username: 'asc' },
      take: 20,
    });
    return { data: users.map((u) => u.username) };
  }
}

