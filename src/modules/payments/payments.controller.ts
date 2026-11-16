import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ListPaymentsDto } from './dto/list-payments.dto';
import { PaymentResponseDto, PaymentListResponseDto } from './dto/payment.dto';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreatePaymentDto): Promise<PaymentResponseDto> {
    return this.paymentsService.createPayment(dto);
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<PaymentResponseDto> {
    return this.paymentsService.getPayment(id);
  }

  @Get()
  async list(@Query() query: ListPaymentsDto): Promise<PaymentListResponseDto> {
    const res = await this.paymentsService.listPayments(query);
    return {
      items: res.items,
      total: res.total,
      page: res.page,
      limit: res.limit,
    };
  }
}