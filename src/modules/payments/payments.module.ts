import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { Payment } from './entities/payment.entity';
import { PaymentReconcileJob, PAYMENT_RECONCILER } from './reconciliation.service';
import { DefaultGatewayReconciler } from './gateway-reconciler.service';
import { RedisModule } from '../../infrastructure/redis/redis.module';

@Module({
  imports: [RedisModule, TypeOrmModule.forFeature([Payment])],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    PaymentReconcileJob,
    { provide: PAYMENT_RECONCILER, useClass: DefaultGatewayReconciler },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}