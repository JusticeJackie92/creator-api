import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, MaxLength, Matches, IsObject } from 'class-validator';

export class UpdateProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50)
  displayName?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000)
  bio?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100)
  location?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  @Matches(/^[a-f0-9-]{36}$/, { message: 'avatarMediaId must be a media id you own' })
  avatarMediaId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  @Matches(/^[a-f0-9-]{36}$/)
  bannerMediaId?: string;

  @ApiPropertyOptional({ description: 'e.g. { "twitter": "https://..." }' })
  @IsOptional() @IsObject()
  socialLinks?: Record<string, string>;
}
