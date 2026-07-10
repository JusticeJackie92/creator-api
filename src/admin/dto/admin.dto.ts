import {
  IsBoolean, IsEmail, IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength,
} from 'class-validator';
import { Role } from '@prisma/client';

export class AdminCreateUserDto {
  @IsEmail()
  email!: string;

  @IsString() @MinLength(8) @MaxLength(128)
  password!: string;

  @IsString() @Matches(/^[a-zA-Z0-9_]{3,30}$/, { message: 'username must be 3-30 chars: letters, numbers, underscore' })
  username!: string;

  @IsString() @MaxLength(50)
  displayName!: string;

  @IsOptional() @IsEnum(Role)
  role?: Role;

  @IsOptional() @IsBoolean()
  emailVerified?: boolean;
}

export class AdminUpdateUserDto {
  @IsOptional() @IsString() @MaxLength(50)
  displayName?: string;

  @IsOptional() @IsString() @Matches(/^[a-zA-Z0-9_]{3,30}$/, { message: 'invalid username' })
  username?: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  bio?: string;

  @IsOptional() @IsEnum(Role)
  role?: Role;

  @IsOptional() @IsBoolean()
  emailVerified?: boolean;
}

export class AdminResetPasswordDto {
  @IsString() @MinLength(8) @MaxLength(128)
  password!: string;
}

export class AdminMakeCreatorDto {
  @IsOptional() @IsBoolean()
  verified?: boolean;
}
