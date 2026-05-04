import { Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-github2';

export type GithubProfile = {
  id: string;
  displayName: string;
  emails?: { value: string }[];
  photos?: { value: string }[];
};

@Injectable()
export class GithubStrategy extends PassportStrategy(Strategy, 'github') {
  private readonly logger = new Logger(GithubStrategy.name);

  constructor() {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;

    super({
      clientID: clientId ?? '',
      clientSecret: clientSecret ?? '',
      callbackURL: 'http://localhost:3000/auth/github/callback',
      scope: ['user:email'],
    });

    this.logger.log(`GitHub OAuth initialized. ClientID: ${clientId ? 'set' : 'MISSING'}`);
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: GithubProfile,
  ) {
    return {
      githubId: profile.id,
      email: profile.emails?.[0]?.value,
      username: profile.displayName,
      avatarUrl: profile.photos?.[0]?.value,
    };
  }
}