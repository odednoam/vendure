/* tslint:disable:no-console */
import {
    ConfigService,
    EventBus,
    OnVendureBootstrap, OrderLine,
    OrderStateTransitionEvent, orderStateTransitions, PluginCommonModule,
    VendurePlugin,
} from '@vendure/core';
import { OrderState } from '@vendure/core/dist/service/helpers/order-state-machine/order-state';
import fetch from 'node-fetch';

@VendurePlugin({
    imports: [PluginCommonModule],
})
export class PrintfulOrdersPlugin implements OnVendureBootstrap {
    private static printfulApiKey: string;
    constructor(
        private eventBus: EventBus,
    ) {}

    public static init(printfulApiKey: string) {
        this.printfulApiKey = printfulApiKey;
        return PrintfulOrdersPlugin;
    }

    async onVendureBootstrap() {
        console.log('INITIALIZING PLUGIN');
        this.eventBus.ofType(OrderStateTransitionEvent).subscribe(async (event: OrderStateTransitionEvent) => {
            if (event.toState === 'PaymentSettled') {
                console.log(event);
                const newOrder = {
                    external_id: event.order.code,
                    shipping: event.order.shippingMethod?.code,
                    recipient: {
                        name: event.order.shippingAddress.fullName,
                        address1: event.order.shippingAddress.streetLine1,
                        address2: event.order.shippingAddress.streetLine2,
                        city: event.order.shippingAddress.city,
                        state_code: '',
                        state_name: event.order.shippingAddress.province,
                        country_code: event.order.shippingAddress.countryCode,
                        country_name: event.order.shippingAddress.country,
                        zip: event.order.shippingAddress.postalCode,
                        phone: event.order.shippingAddress.phoneNumber,
                        email: event.order.customer?.emailAddress,
                    },
                    items: event.order.lines
                        .filter((line: OrderLine) => line.productVariant.sku.startsWith('PFL'))
                        .map((line: OrderLine) => {
                            return {
                                sync_variant_id: line.productVariant.sku.substring(4),
                                quantity: line.quantity,
                                retail_price: line.unitPriceWithTax / 100.0,
                            };
                        }),
                    retail_costs: {
                        shipping: event.order.shippingWithTax / 100.0,
                    },
                };
                const res = await fetch('https://api.printful.com/orders',
                    {
                        method: 'POST',
                        body: JSON.stringify(newOrder),
                        headers: {
                            authorization: 'Basic ' + new Buffer(PrintfulOrdersPlugin.printfulApiKey).toString('base64'),
                        },
                    });
                console.log(res);
            }
        });
    }

}
