import { Module } from '@nestjs/common';
import { CreatorsService } from './creators.service';
import { CreatorsController } from './creators.controller';

@Module({ controllers: [CreatorsController], providers: [CreatorsService] })
export class CreatorsModule {}
