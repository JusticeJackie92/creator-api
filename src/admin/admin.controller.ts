import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { AccountStatus, ReportStatus, Role } from '@prisma/client';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN) // class-level: everything here needs ADMIN+ (SUPER_ADMIN inherits)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview')
  overview() {
    return this.admin.overview();
  }

  @Get('reports')
  @Roles(Role.MODERATOR) // moderators can review reports
  reports(@Query('status') status?: ReportStatus) {
    return this.admin.listReports(status);
  }

  @Patch('reports/:id')
  @Roles(Role.MODERATOR)
  resolveReport(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body('status') status: ReportStatus) {
    return this.admin.resolveReport(user.id, id, status);
  }

  @Patch('users/:id/status')
  setStatus(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body('status') status: AccountStatus) {
    return this.admin.setUserStatus(user.id, id, status);
  }

  @Get('audit-logs')
  audit(@Query('userId') userId?: string) {
    return this.admin.auditTrail(userId);
  }
}
