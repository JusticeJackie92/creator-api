import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class SendMessageDto {
  @ApiProperty() @IsString()
  conversationId!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(5000)
  body?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsString({ each: true })
  mediaIds?: string[];

  @ApiPropertyOptional() @IsOptional() @IsString()
  replyToId?: string;
}

export class StartConversationDto {
  @ApiProperty() @IsString()
  recipientUserId!: string;
}
