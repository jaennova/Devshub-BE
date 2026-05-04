import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CacheInterceptor } from '@nestjs/cache-manager';
import { type Express, Request } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AppError, ErrorCode } from '../common/errors';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { TrendingBuildersBy, TrendingBuildersQueryDto } from './dto/trending-builders-query.dto';
import { UsersService } from './users.service';

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

type AuthRequest = Request & {
  user: {
    userId: string;
    email: string;
    username: string;
  };
};

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @ApiOperation({ summary: 'Get all usernames (for @mentions autocomplete)' })
  @ApiBearerAuth()
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  @ApiOkResponse({ description: 'Object with data array of usernames' })
  @UseGuards(JwtAuthGuard)
  @Get('usernames')
  getUsernames() {
    return this.usersService.getUsernames();
  }

  @ApiOperation({ summary: 'Search users by username (min 3 chars, for @mentions)' })
  @ApiBearerAuth()
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  @ApiOkResponse({ description: 'Object with data array of matching usernames' })
  @ApiQuery({ name: 'q', required: true, type: String, description: 'Min 3 characters' })
  @UseGuards(JwtAuthGuard)
  @Get('usernames/search')
  searchUsernames(@Query('q') q: string) {
    return this.usersService.searchUsernames(q);
  }

  @ApiOperation({ summary: 'Get my profile (private)' })
  @ApiBearerAuth()
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  @ApiOkResponse({ description: 'Profile retrieved successfully' })
  @UseGuards(JwtAuthGuard)
  @Get('my-profile')
  getMyProfile(@Req() req: AuthRequest) {
    return this.usersService.getMyProfileWithBookmarks(req.user.userId);
  }

  @ApiOperation({
    summary: 'Update my profile',
    description:
      'Acepta **application/json** o **multipart/form-data** (campo de archivo **`photo`**). Sube a S3 bajo **`S3_USERS_FOLDER`** (por defecto `profile-media/`; usa el prefijo sin restricciones de lectura). En `photoKey` se guarda la URL pública. Opcional **`S3_USER_PHOTO_BASE_URL`** para otra base.',
  })
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({ type: UpdateProfileDto })
  @ApiBearerAuth()
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  @ApiOkResponse({ description: 'Profile updated; mismo formato que GET /users/my-profile' })
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('photo', {
      limits: { fileSize: MAX_PHOTO_BYTES },
      fileFilter: (_req, file, cb) => {
        const ok = /^image\/(jpeg|png|gif|webp)$/.test(file.mimetype);
        if (!ok) {
          cb(
            AppError.httpBadRequest(
              ErrorCode.USER_PROFILE_IMAGE_TYPE_INVALID,
              'Solo se permiten imágenes JPEG, PNG, GIF o WebP',
            ),
            false,
          );
          return;
        }
        cb(null, true);
      },
    }),
  )
  @Patch('my-profile')
  updateMyProfile(
    @Req() req: AuthRequest,
    @Body() dto: UpdateProfileDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.usersService.updateMyProfile(req.user.userId, dto, file);
  }

  // Backwards-compatible alias (can be removed later)
  @UseGuards(JwtAuthGuard)
  @Get('me')
  getMe(@Req() req: AuthRequest) {
    return this.usersService.getMyProfileWithBookmarks(req.user.userId);
  }

  @ApiOperation({ summary: 'Conteos: cuántos me siguen y a cuántos sigo' })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: 'followersCount = seguidores; followingCount = a cuántos sigues',
    schema: { example: { followersCount: 12, followingCount: 5 } },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  @UseGuards(JwtAuthGuard)
  @Get('me/follow-counts')
  getMyFollowCounts(@Req() req: AuthRequest) {
    return this.usersService.getMyFollowCounts(req.user.userId);
  }

  @ApiOperation({ summary: 'Dejar de seguir a un usuario' })
  @ApiBearerAuth()
  @ApiParam({ name: 'username', example: 'otrodev' })
  @ApiBadRequestResponse({ description: 'Username vacío o operación no válida' })
  @ApiNotFoundResponse({ description: 'Usuario no encontrado' })
  @ApiOkResponse({
    description: 'Unfollow',
    schema: { example: { following: false, username: 'otrodev' } },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  @UseGuards(JwtAuthGuard)
  @Delete(':username/follow')
  unfollowUser(@Req() req: AuthRequest, @Param('username') username: string) {
    return this.usersService.unfollowUser(req.user.userId, username);
  }

  @ApiOperation({ summary: 'Seguir a un usuario' })
  @ApiBearerAuth()
  @ApiParam({ name: 'username', example: 'otrodev' })
  @ApiBadRequestResponse({ description: 'Username inválido o intento de seguirse a uno mismo' })
  @ApiNotFoundResponse({ description: 'Usuario no encontrado' })
  @ApiOkResponse({
    description: 'Follow creado o ya existía (idempotente)',
    schema: { example: { following: true, username: 'otrodev' } },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  @UseGuards(JwtAuthGuard)
  @Post(':username/follow')
  followUser(@Req() req: AuthRequest, @Param('username') username: string) {
    return this.usersService.followUser(req.user.userId, username);
  }

  @ApiOperation({
    summary: 'Get trending builders by followers and/or post likes',
    description:
      'Solo aparecen usuarios activos que cumplen al menos uno: más de **10 seguidores** **o** algún **post publicado con más de 10 likes**. Público; con Bearer opcional, **`isFollowedByViewer`**.',
  })
  @ApiBearerAuth()
  @ApiQuery({
    name: 'by',
    required: false,
    enum: TrendingBuildersBy,
    description: 'Ranking strategy: combined, followers, or likes',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max number of users returned (1-100)',
  })
  @ApiUnauthorizedResponse({
    description: 'Solo si envías Bearer y el token es inválido',
  })
  @ApiOkResponse({
    description: 'Trending builders computed successfully',
    schema: {
      example: {
        by: 'combined',
        limit: 10,
        totalCandidates: 24,
        items: [
          {
            id: 'clh2a3b4c5d6e7f8g9h0i1j2',
            username: 'hiramdev',
            photoKey:
              'https://nuvix-media.s3.us-east-1.amazonaws.com/profile-media/clh2a3b4c5d6e7f8g9h0i1j2/1720000000000-a1b2c3d4e5f6g7h8.png',
            position: 'Backend Engineer',
            description: 'Building APIs',
            followersCount: 120,
            likesReceivedCount: 430,
            score: 550,
            isFollowedByViewer: true,
          },
        ],
      },
    },
  })
  @UseGuards(OptionalJwtAuthGuard)
  @Get('trending-builders')
  getTrendingBuilders(
    @Query() query: TrendingBuildersQueryDto,
    @Req() req: Request & { user?: AuthRequest['user'] },
  ) {
    return this.usersService.getTrendingBuilders(query, req.user?.userId);
  }

  @ApiOperation({ summary: 'Get my followers (private)' })
  @ApiBearerAuth()
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  @ApiOkResponse({ description: 'Followers retrieved successfully' })
  @UseGuards(JwtAuthGuard)
  @Get('my-followers')
  getMyFollowers(@Req() req: AuthRequest) {
    return this.usersService.getMyFollowers(req.user.userId);
  }

  @ApiOperation({ summary: 'Get my following (private)' })
  @ApiBearerAuth()
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  @ApiOkResponse({ description: 'Following retrieved successfully' })
  @UseGuards(JwtAuthGuard)
  @Get('my-following')
  getMyFollowing(@Req() req: AuthRequest) {
    return this.usersService.getMyFollowing(req.user.userId);
  }

  @ApiOperation({
    summary: 'Perfil por username',
    description:
      'Requiere **Bearer**. Incluye **`isFollowedByViewer`**: si el usuario autenticado sigue a ese perfil (false si es tu propio perfil).',
  })
  @ApiBearerAuth()
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  @ApiOkResponse({ description: 'Perfil con isFollowedByViewer' })
  @ApiNotFoundResponse({ description: 'User not found' })
  @UseGuards(JwtAuthGuard)
  @Get(':username')
  getByUsername(@Param('username') username: string, @Req() req: AuthRequest) {
    return this.usersService.getProfileByUsername(username, req.user.userId);
  }
}

