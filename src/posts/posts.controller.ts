import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PostsService } from './posts.service';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { CreatePostDto, CommentDto } from './dto/post.dto';

@ApiTags('posts')
@ApiBearerAuth()
@Controller('posts')
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  @Post()
  @Roles(Role.CREATOR)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePostDto) {
    return this.posts.create(user.id, dto);
  }

  @Get('feed')
  homeFeed(@CurrentUser() user: AuthUser, @Query('cursor') cursor?: string) {
    return this.posts.homeFeed(user.id, cursor);
  }

  @Get('bookmarks')
  bookmarks(@CurrentUser() user: AuthUser, @Query('cursor') cursor?: string) {
    return this.posts.bookmarksFeed(user.id, cursor);
  }

  @Get('creator/:creatorUserId')
  creatorFeed(
    @CurrentUser() user: AuthUser,
    @Param('creatorUserId') creatorUserId: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.posts.creatorFeed(user.id, creatorUserId, cursor);
  }

  @Post(':id/like')
  like(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.posts.like(user.id, id);
  }

  @Delete(':id/like')
  unlike(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.posts.unlike(user.id, id);
  }

  @Post(':id/bookmark')
  bookmark(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.posts.bookmark(user.id, id);
  }

  @Delete(':id/bookmark')
  unbookmark(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.posts.unbookmark(user.id, id);
  }

  @Post(':id/comments')
  comment(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CommentDto) {
    return this.posts.comment(user.id, id, dto);
  }

  @Get(':id/comments')
  comments(@Param('id') id: string, @Query('cursor') cursor?: string) {
    return this.posts.comments(id, cursor);
  }

  @Patch(':id/pin')
  @Roles(Role.CREATOR)
  pin(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body('pinned') pinned: boolean) {
    return this.posts.pin(user.id, id, !!pinned);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.posts.remove(user.id, id);
  }
}
