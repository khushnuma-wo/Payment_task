import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PaymentsService } from '../payments/payments.service';

const userRoom = (userId: string): string => `user:${userId}`;
const paymentRoom = (paymentId: string): string => `payment:${paymentId}`;

export interface PaymentRealtimeEvent {
  eventType: string;
  paymentId: string;
  status?: string;
  userId?: string;
  data?: unknown;
}

/**
 * Real-time channel for payment updates.
 *
 *  - Authenticates the handshake with a JWT (query param `token`).
 *  - Auto-subscribes the socket to its `user:<id>` room.
 *  - Clients additionally join `payment:<id>` rooms after an ownership check.
 *  - Cross-instance fan-out is handled by the RedisIoAdapter installed in main.ts.
 */
@WebSocketGateway({
  cors: { origin: '*' },
  path: '/socket.io',
})
export class PaymentsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(PaymentsGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly payments: PaymentsService,
  ) {}

  async handleConnection(socket: Socket): Promise<void> {
    try {
      const token = (socket.handshake.auth?.token ?? socket.handshake.query?.token) as string;
      if (!token) throw new Error('missing token');
      const payload = await this.jwt.verifyAsync(token);
      socket.data.userId = payload.sub;
      void socket.join(userRoom(payload.sub));
      this.logger.log(`socket connected user=${payload.sub} sid=${socket.id}`);
    } catch {
      socket.disconnect(true);
    }
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    this.logger.log(`socket disconnected sid=${socket.id}`);
  }

  /**
   * Subscribe to all events for a specific payment. Ownership is verified so a
   * user cannot listen in on other users' payments.
   */
  @SubscribeMessage('payment:subscribe')
  async subscribeToPayment(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { paymentId: string },
  ): Promise<{ ok: boolean; paymentId: string }> {
    const userId = socket.data.userId as string;
    const payment = await this.payments.getPayment(body.paymentId);
    if (payment.userId !== userId) {
      return { ok: false, paymentId: body.paymentId };
    }
    await socket.join(paymentRoom(body.paymentId));
    // Immediately hydrate the current state so a fresh subscription is consistent.
    socket.emit('payment:update', {
      eventType: 'payment.snapshot',
      paymentId: body.paymentId,
      status: payment.status,
    });
    return { ok: true, paymentId: body.paymentId };
  }

  /** Called by the outbox broadcaster to fan an event out to rooms. */
  broadcast(evt: PaymentRealtimeEvent): void {
    this.logger.debug(`broadcast to ${paymentRoom(evt.paymentId)}: ${JSON.stringify(evt)}`);
    this.server.to(paymentRoom(evt.paymentId)).emit('payment:update', evt);
    if (evt.userId) {
      this.server.to(userRoom(evt.userId)).emit('payment:update', evt);
    }
  }
}