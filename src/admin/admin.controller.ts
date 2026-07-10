import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AccountStatus, ReportStatus, Role } from '@prisma/client';
import { AdminService } from './admin.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { AdminCreateUserDto, AdminUpdateUserDto, AdminResetPasswordDto, AdminMakeCreatorDto } from './dto/admin.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN) // class-level: ADMIN+ required (SUPER_ADMIN inherits)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  private actor(user: AuthUser) {
    return { id: user.id, role: user.role as Role };
  }

  @Get('overview')
  overview() {
    return this.admin.overview();
  }

  // ---- users ----
  @Get('users')
  listUsers(
    @Query('query') query?: string,
    @Query('role') role?: Role,
    @Query('status') status?: AccountStatus,
    @Query('cursor') cursor?: string,
  ) {
    return this.admin.listUsers({ query, role, status, cursor });
  }

  @Get('users/:id')
  getUser(@Param('id') id: string) {
    return this.admin.getUser(id);
  }

  @Post('users')
  createUser(@CurrentUser() user: AuthUser, @Body() dto: AdminCreateUserDto) {
    return this.admin.createUser(this.actor(user), dto);
  }

  @Patch('users/:id')
  updateUser(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AdminUpdateUserDto) {
    return this.admin.updateUser(this.actor(user), id, dto);
  }

  @Patch('users/:id/status')
  setStatus(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body('status') status: AccountStatus) {
    return this.admin.setUserStatus(this.actor(user), id, status);
  }

  @Patch('users/:id/role')
  setRole(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body('role') role: Role) {
    return this.admin.setUserRole(this.actor(user), id, role);
  }

  @Post('users/:id/make-creator')
  makeCreator(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AdminMakeCreatorDto) {
    return this.admin.makeCreator(this.actor(user), id, dto.verified);
  }

  @Patch('users/:id/verify')
  verify(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body('verified') verified: boolean) {
    return this.admin.setVerifiedBadge(this.actor(user), id, !!verified);
  }

  @Post('users/:id/reset-password')
  resetPassword(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AdminResetPasswordDto) {
    return this.admin.resetPassword(this.actor(user), id, dto.password);
  }

  @Delete('users/:id')
  deleteUser(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.admin.deleteUser(this.actor(user), id);
  }

  // ---- moderation ----
  @Get('posts')
  posts(@Query('cursor') cursor?: string) {
    return this.admin.listPosts(cursor);
  }

  @Delete('posts/:id')
  removePost(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.admin.deletePost(this.actor(user), id);
  }

  @Get('reports')
  @Roles(Role.MODERATOR)
  reports(@Query('status') status?: ReportStatus) {
    return this.admin.listReports(status);
  }

  @Patch('reports/:id')
  @Roles(Role.MODERATOR)
  resolveReport(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body('status') status: ReportStatus) {
    return this.admin.resolveReport(user.id, id, status);
  }

  // ---- finance & audit ----
  @Get('transactions')
  transactions(@Query('cursor') cursor?: string) {
    return this.admin.listTransactions(cursor);
  }

  @Get('audit-logs')
  audit(@Query('userId') userId?: string) {
    return this.admin.auditTrail(userId);
  }
}
