import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { UpdateProfileDto } from './dto/update-profile.dto';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.users.me(user.id);
  }

  @Patch('me')
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(user.id, dto);
  }

  @Public()
  @Get('profile/:username')
  publicProfile(@Param('username') username: string) {
    return this.users.publicProfile(username.toLowerCase());
  }

  @Get('by-id/:id')
  miniById(@Param('id') id: string) {
    return this.users.miniById(id);
  }

  @Post('block/:userId')
  block(@CurrentUser() user: AuthUser, @Param('userId') userId: string) {
    return this.users.blockUser(user.id, userId);
  }

  @Delete('block/:userId')
  unblock(@CurrentUser() user: AuthUser, @Param('userId') userId: string) {
    return this.users.unblockUser(user.id, userId);
  }

  @Post('follow/:userId')
  follow(@CurrentUser() user: AuthUser, @Param('userId') userId: string) {
    return this.users.follow(user.id, userId);
  }

  @Delete('follow/:userId')
  unfollow(@CurrentUser() user: AuthUser, @Param('userId') userId: string) {
    return this.users.unfollow(user.id, userId);
  }
}
