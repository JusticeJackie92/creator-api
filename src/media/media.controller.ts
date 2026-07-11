import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { MediaService } from './media.service';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ConfirmUploadDto, CreateFolderDto, SignUploadDto, UpdateMediaAccessDto } from './dto/media.dto';

@ApiTags('media')
@ApiBearerAuth()
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('sign')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  sign(@CurrentUser() user: AuthUser, @Body() dto: SignUploadDto) {
    return this.media.signUpload(user.id, dto.resourceType);
  }

  @Post('confirm')
  confirm(@CurrentUser() user: AuthUser, @Body() dto: ConfirmUploadDto) {
    return this.media.confirmUpload(user.id, dto);
  }

  @Get('vault')
  vault(
    @CurrentUser() user: AuthUser,
    @Query('folderId') folderId?: string,
    @Query('cursor') cursor?: string,
    @Query('take') take?: string,
  ) {
    return this.media.listVault(user.id, folderId, cursor, take ? Number(take) : 20);
  }

  @Post('folders')
  createFolder(@CurrentUser() user: AuthUser, @Body() dto: CreateFolderDto) {
    return this.media.createFolder(user.id, dto);
  }

  @Patch(':id/folder')
  move(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body('folderId') folderId: string | null) {
    return this.media.moveToFolder(user.id, id, folderId ?? null);
  }

  @Patch(':id/access')
  updateAccess(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateMediaAccessDto) {
    return this.media.updateAccess(user.id, id, dto);
  }

  @Delete(':id')
  trash(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.media.trash(user.id, id);
  }

  @Public()
  @Get(':id/public-url')
  publicUrl(@Param('id') id: string) {
    return this.media.getPublicUrl(id);
  }

  @Get(':id/meta')
  meta(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.media.getMediaMeta(user.id, id);
  }

  @Get(':id/url')
  deliveryUrl(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.media.getDeliveryUrl(user.id, id);
  }
}
