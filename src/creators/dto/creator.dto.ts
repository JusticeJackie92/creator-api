import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { PlanInterval } from '@prisma/client';

export class BecomeCreatorDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000)
  welcomeMessage?: string;

  @ApiPropertyOptional({ example: '#6d5efc' }) @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'themeColor must be a hex color' })
  themeColor?: string;
}

export class UpsertPlanDto {
  @ApiProperty({ enum: PlanInterval }) @IsEnum(PlanInterval)
  interval!: PlanInterval;

  @ApiProperty({ description: 'Price in cents (min 100 = $1, max 500000 = $5000)' })
  @IsInt() @Min(100) @Max(500_000)
  priceCents!: number;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(30)
  trialDays?: number;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(90)
  discountPct?: number;
}
