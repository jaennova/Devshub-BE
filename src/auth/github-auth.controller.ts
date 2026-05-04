import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Response } from 'express';
import { AuthService } from './auth.service';

type GithubUser = {
  githubId: string;
  email?: string;
  username: string;
};

@ApiTags('Auth')
@Controller('auth')
export class GithubAuthController {
  constructor(private readonly authService: AuthService) {}

  @ApiOperation({ summary: 'Login with GitHub (redirect to GitHub)' })
  @ApiFoundResponse({ description: 'Redirects to GitHub OAuth' })
  @Get('github')
  @UseGuards(AuthGuard('github'))
  githubLogin() {}

  @ApiOperation({
    summary: 'GitHub OAuth callback',
    description: 'Called by GitHub after authorization',
  })
  @Get('github/callback')
  @UseGuards(AuthGuard('github'))
  async githubCallback(@Req() req: Request & { user: GithubUser }, @Res() res: Response) {
    const result = await this.authService.loginWithGithub(req.user);
    const token = encodeURIComponent(result.accessToken);
    res.redirect(`${process.env.APP_URL ?? 'http://localhost:3000'}/auth/github/success?token=${token}`);
  }
}