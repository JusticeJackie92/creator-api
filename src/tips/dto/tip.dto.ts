import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateTipDto {
  @ApiProperty() @IsString()
  creatorUserId!: string;

  @ApiProperty({ description: 'Cents. Min 100 ($1), max 50000 ($500) per tip.' })
  @IsInt() @Min(100) @Max(50_000)
  amountCents!: number;

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  anonymous?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500)
  message?: string;

  @ApiProperty({ enum: ['NOWPAYMENTS', 'PAYPAL'] }) @IsIn(['NOWPAYMENTS', 'PAYPAL'])
  provider!: 'NOWPAYMENTS' | 'PAYPAL';
}
