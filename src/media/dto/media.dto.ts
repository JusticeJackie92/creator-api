import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { ContentAccess } from '@prisma/client';

export class SignUploadDto {
  @ApiProperty({ enum: ['image', 'video'] })
  @IsIn(['image', 'video'])
  resourceType!: 'image' | 'video';

  @ApiPropertyOptional({ description: 'Original filename, used only to infer an extension' })
  @IsOptional() @IsString() @MaxLength(255)
  filename?: string;
}

export class ConfirmUploadDto {
  @ApiProperty({ description: 'Storj object key returned by /media/sign' })
  @IsString() @MaxLength(512)
  // Must live under the users/ tree. The exact "users/{callerId}/..." ownership
  // check is enforced in MediaService.confirmUpload against the JWT user id, so
  // this only needs to guard the general shape (any id, nested paths allowed).
  @Matches(/^users\/[^/]+\/[A-Za-z0-9._/-]+$/, { message: 'Invalid object key' })
  key!: string;

  @ApiProperty({ enum: ['image', 'video'] })
  @IsIn(['image', 'video'])
  resourceType!: 'image' | 'video';
}

export class UpdateMediaAccessDto {
  @ApiProperty({ enum: ContentAccess }) @IsEnum(ContentAccess)
  access!: ContentAccess;

  @ApiPropertyOptional({ description: 'Required when access = PAY_PER_VIEW (cents)' })
  @IsOptional() @IsInt() @Min(100) @Max(1_000_000)
  priceCents?: number;
}

export class CreateFolderDto {
  @ApiProperty() @IsString() @MaxLength(60)
  @Matches(/^[\w \-]{1,60}$/, { message: 'Folder name: letters, numbers, spaces, dashes' })
  name!: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  parentId?: string;
}
