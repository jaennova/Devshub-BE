import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { MailModule } from '../mail/mail.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { GithubAuthController } from './github-auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';
import { GithubStrategy } from './github.strategy';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';

@Module({
  imports: [
    PrismaModule,
    MailModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'dev_secret_change_me',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [AuthController, GithubAuthController],
  providers: [AuthService, JwtStrategy, GithubStrategy, JwtAuthGuard, OptionalJwtAuthGuard],
  exports: [AuthService, JwtAuthGuard, OptionalJwtAuthGuard, JwtModule],
})
export class AuthModule {}
