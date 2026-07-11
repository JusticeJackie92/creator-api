import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CreatorsService } from './creators.service';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { Public } from '../common/decorators/public.decorator';
import { BecomeCreatorDto, UpsertPlanDto } from './dto/creator.dto';

@ApiTags('creators')
@ApiBearerAuth()
@Controller('creators')
export class CreatorsController {
  constructor(private readonly creators: CreatorsService) {}

  @Public()
  @Get('discover/public')
  discoverPublic(@Query('limit') limit?: string) {
    return this.creators.discover(undefined, limit ? Number(limit) : 24);
  }

  @Get('discover')
  discover(@CurrentUser() user: AuthUser, @Query('limit') limit?: string) {
    return this.creators.discover(user.id, limit ? Number(limit) : 12);
  }

  @Post('become')
  become(@CurrentUser() user: AuthUser, @Body() dto: BecomeCreatorDto) {
    return this.creators.becomeCreator(user.id, dto);
  }

  @Patch('settings')
  @Roles(Role.CREATOR)
  updateSettings(@CurrentUser() user: AuthUser, @Body() dto: BecomeCreatorDto) {
    return this.creators.updateSettings(user.id, dto);
  }

  @Post('plans')
  @Roles(Role.CREATOR)
  upsertPlan(@CurrentUser() user: AuthUser, @Body() dto: UpsertPlanDto) {
    return this.creators.upsertPlan(user.id, dto);
  }

  @Delete('plans/:id')
  @Roles(Role.CREATOR)
  deactivatePlan(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.creators.deactivatePlan(user.id, id);
  }

  @Get('dashboard')
  @Roles(Role.CREATOR)
  dashboard(@CurrentUser() user: AuthUser) {
    return this.creators.myDashboard(user.id);
  }
}
