import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';

export class SubscribeDto {
  @ApiProperty() @IsString()
  planId!: string;

  @ApiProperty({ enum: ['NOWPAYMENTS', 'PAYPAL'] }) @IsIn(['NOWPAYMENTS', 'PAYPAL'])
  provider!: 'NOWPAYMENTS' | 'PAYPAL';
}
