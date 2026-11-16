import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PaymentsGateway } from './payments.gateway';
import { RealtimeBroadcaster } from './realtime.broadcaster';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [
    PaymentsModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (c: ConfigService) => ({
        secret: c.get<string>('auth.jwtSecret'),
        signOptions: { expiresIn: c.get<string>('auth.jwtExpiresIn') },
      }),
    }),
  ],
  providers: [PaymentsGateway, RealtimeBroadcaster],
  exports: [PaymentsGateway],
})
export class RealtimeModule {}