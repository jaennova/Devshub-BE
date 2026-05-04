import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, User } from '../generated/prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { AppError, ErrorCode } from '../common/errors';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
  ) {}

  async register(dto: RegisterDto) {
    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const email = dto.email.toLowerCase();
    const username = dto.username;

    const pending = await this.prisma.$transaction(async (tx) => {
      const existingByEmail = await tx.user.findUnique({
        where: { email },
        select: { id: true, isVerified: true },
      });
      if (existingByEmail?.isVerified) {
        AppError.conflict(ErrorCode.AUTH_EMAIL_IN_USE, 'Email already in use');
      }

      const existingByUsername = await tx.user.findUnique({
        where: { username },
        select: { id: true, isVerified: true },
      });
      if (existingByUsername?.isVerified) {
        AppError.conflict(ErrorCode.AUTH_USERNAME_IN_USE, 'Username already in use');
      }


      const legacyIds = [existingByEmail?.id, existingByUsername?.id].filter(
        (v): v is string => Boolean(v),
      );
      if (legacyIds.length > 0) {
        await tx.user.deleteMany({
          where: { id: { in: legacyIds }, isVerified: false },
        });
      }


      await tx.pendingRegistration.deleteMany({
        where: { OR: [{ email }, { username }] },
      });

      const token = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);

      return tx.pendingRegistration.create({
        data: {
          email,
          username,
          password: hashedPassword,
          position: dto.puesto,
          description: dto.description,
          techStack: dto.techStacks ?? [],
          socialLinks: dto.socialLinks as Prisma.InputJsonValue | undefined,
          token,
          expiresAt,
        },
      });
    });

    await this.mailService.sendVerificationEmail({
      email: pending.email,
      username: pending.username,
      token: pending.token,
    });

    return {
      message: 'Account created. Please verify your email before logging in.',
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (!user) {
      AppError.unauthorized(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Invalid credentials');
    }

    const passwordMatches = await bcrypt.compare(dto.password, user.password);
    if (!passwordMatches) {
      AppError.unauthorized(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Invalid credentials');
    }

    if (!user.isVerified) {
      AppError.unauthorized(
        ErrorCode.AUTH_ACCOUNT_NOT_VERIFIED,
        'Account not verified. Please verify your email first.',
      );
    }

    return this.buildAuthResponse(user);
  }

  async verifyEmail(dto: VerifyEmailDto) {
    const pending = await this.prisma.pendingRegistration.findUnique({
      where: { token: dto.token },
    });

    if (!pending) {
      AppError.badRequest(ErrorCode.AUTH_VERIFY_TOKEN_INVALID, 'Invalid verification token');
    }

    if (pending.expiresAt.getTime() < Date.now()) {
      await this.prisma.pendingRegistration.delete({
        where: { id: pending.id },
      });
      AppError.badRequest(ErrorCode.AUTH_VERIFY_TOKEN_EXPIRED, 'Verification token expired');
    }

    const user = await this.prisma.$transaction(async (tx) => {
      const existingByEmail = await tx.user.findUnique({
        where: { email: pending.email },
        select: { id: true },
      });
      if (existingByEmail) {
        AppError.conflict(ErrorCode.AUTH_EMAIL_IN_USE, 'Email already in use');
      }
      const existingByUsername = await tx.user.findUnique({
        where: { username: pending.username },
        select: { id: true },
      });
      if (existingByUsername) {
        AppError.conflict(ErrorCode.AUTH_USERNAME_IN_USE, 'Username already in use');
      }

      const created = await tx.user.create({
        data: {
          email: pending.email,
          username: pending.username,
          password: pending.password,
          position: pending.position,
          description: pending.description,
          techStack: pending.techStack,
          socialLinks:
            pending.socialLinks === null
              ? undefined
              : (pending.socialLinks as Prisma.InputJsonValue),
          isVerified: true,
        },
      });

      await tx.pendingRegistration.delete({ where: { id: pending.id } });
      return created;
    });

    return this.buildAuthResponse(user);
  }

  private buildAuthResponse(user: User) {
    const payload = { sub: user.id, email: user.email, username: user.username };
    const accessToken = this.jwtService.sign(payload);

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
      },
    };
  }

  async loginWithGithub(profile: { githubId: string; email?: string; username: string }) {
    let user = await this.prisma.user.findUnique({
      where: { githubId: profile.githubId },
    });

    if (!user && profile.email) {
      user = await this.prisma.user.findUnique({
        where: { email: profile.email },
      });
      if (user) {
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: { githubId: profile.githubId },
        });
      }
    }

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email: profile.email ?? `${profile.githubId}@github`,
          username: profile.username,
          password: await bcrypt.hash(randomBytes(32).toString('hex'), 10),
          githubId: profile.githubId,
          isVerified: true,
        },
      });
    }

    return this.buildAuthResponse(user);
  }
}
