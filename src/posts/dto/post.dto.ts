import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min,
} from 'class-validator';
import { ContentAccess } from '@prisma/client';

export class CreatePostDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(10_000)
  body?: string;

  @ApiPropertyOptional({ type: [String], description: 'Media ids you own (max 10 = carousel)' })
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true })
  mediaIds?: string[];

  @ApiPropertyOptional({ enum: ContentAccess }) @IsOptional() @IsEnum(ContentAccess)
  access?: ContentAccess;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(100) @Max(1_000_000)
  priceCents?: number;

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  draft?: boolean;

  @ApiPropertyOptional({ description: 'ISO date to schedule publish' })
  @IsOptional() @IsDateString()
  scheduledAt?: string;
}

export class CommentDto {
  @ApiProperty() @IsString() @MaxLength(2000)
  body!: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  parentId?: string;
}
