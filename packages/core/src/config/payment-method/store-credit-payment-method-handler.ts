import { LanguageCode } from '@vendure/common/lib/generated-types';
import { getConnectionManager } from 'typeorm';

import { CreatePaymentResult, PaymentMethodHandler } from './payment-method-handler';

/**
 * A dummy API to simulate an SDK provided by a popular payments service.
 */

export const storeCreditPaymentHandler = new PaymentMethodHandler({
    code: 'store-credit-payment-provider',
    description: [{ languageCode: LanguageCode.en, value: 'Store-Credit Payment Provider' }],
    args: {},
    createPayment: async (order, args, metadata): Promise<CreatePaymentResult> => {
        const customFields: any = order.customer?.customFields;
        try {
            if (customFields && customFields.creditBalance >= order.total) {
                customFields.creditBalance -= order.total;
                await getConnectionManager().get().manager.save(order.customer);
                return {
                    amount: order.total,
                    state: 'Settled',
                    transactionId: Math.random().toString(36).substr(3),
                    metadata,
                };
            } else {
                return {
                    amount: order.total,
                    state: 'Declined',
                    metadata: {
                        errorMessage: 'Not enough credits for purchase.',
                    },
                };
            }
        } catch (err) {
            return {
                amount: order.total,
                state: 'Declined',
                metadata: {
                    errorMessage: err.message,
                },
            };
        }
    },
    settlePayment: async () => {
        return {
            success: true,
            metadata: {
                captureId: Math.random().toString(36).substr(3),
            },
        };
    },
});
