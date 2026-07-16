import { ApiProperty } from '@nestjs/swagger';
import { Equals, IsEmail, IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Strong password policy: 10+ chars, upper, lower, digit.
 * Emails normalized to lowercase to prevent duplicate-account tricks.
 */
const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,}$/;
const PASSWORD_MSG = 'Password must be 10+ characters with upper, lower and a number';

export class RegisterDto {
  @ApiProperty() @IsEmail() @MaxLength(254)
  @Transform(({ value }) => String(value).trim().toLowerCase())
  email!: string;

  @ApiProperty() @IsString() @Matches(PASSWORD_RULE, { message: PASSWORD_MSG }) @MaxLength(128)
  password!: string;

  @ApiProperty() @IsString() @MinLength(3) @MaxLength(30)
  @Matches(/^[a-zA-Z0-9_]+$/, { message: 'Username: letters, numbers, underscore only' })
  @Transform(({ value }) => String(value).trim().toLowerCase())
  username!: string;

  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(50)
  displayName!: string;

  @ApiProperty({
    description:
      'Must be true: confirms the user is 18+ and agrees to the Terms of Service, ' +
      'Privacy Policy, and that the platform hosts adult (18+) content.',
  })
  @Transform(({ value }) => value === true || value === 'true')
  @Equals(true, { message: 'You must confirm you are 18 or older and accept the Terms of Service' })
  acceptedTerms!: boolean;
}

export class LoginDto {
  @ApiProperty() @IsEmail()
  @Transform(({ value }) => String(value).trim().toLowerCase())
  email!: string;

  @ApiProperty() @IsString() @MaxLength(128)
  password!: string;
}

export class VerifyEmailDto {
  @ApiProperty() @IsString() @MaxLength(512)
  token!: string;
}

export class ForgotPasswordDto {
  @ApiProperty() @IsEmail()
  @Transform(({ value }) => String(value).trim().toLowerCase())
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty() @IsString() @MaxLength(512)
  token!: string;

  @ApiProperty() @IsString() @Matches(PASSWORD_RULE, { message: PASSWORD_MSG }) @MaxLength(128)
  newPassword!: string;
}
