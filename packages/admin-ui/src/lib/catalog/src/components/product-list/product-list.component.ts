import { Component, OnInit, ViewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker';
import {
    BaseListComponent,
    CreateProductVariantInput,
    DataService,
    JobQueueService,
    JobState,
    LanguageCode,
    LogicalOperator,
    ModalService,
    NotificationService,
    Product,
    ProductWithVariantsFragment,
    SearchInput,
    SearchProducts,
} from '@vendure/admin-ui/core';
import { EMPTY, Observable } from 'rxjs';
import { delay, map, switchMap, take, takeUntil, withLatestFrom } from 'rxjs/operators';

import { ProductSearchInputComponent } from '../product-search-input/product-search-input.component';

@Component({
    selector: 'vdr-products-list',
    templateUrl: './product-list.component.html',
    styleUrls: ['./product-list.component.scss'],
})
export class ProductListComponent
    extends BaseListComponent<SearchProducts.Query, SearchProducts.Items, SearchProducts.Variables>
    implements OnInit {
    searchTerm = '';
    facetValueIds: string[] = [];
    groupByProduct = true;
    facetValues$: Observable<SearchProducts.FacetValues[]>;
    @ViewChild('productSearchInputComponent', { static: true })
    private productSearchInput: ProductSearchInputComponent;
    constructor(
        private dataService: DataService,
        private modalService: ModalService,
        private notificationService: NotificationService,
        private jobQueueService: JobQueueService,
        router: Router,
        route: ActivatedRoute,
    ) {
        super(router, route);
        super.setQueryFn(
            (...args: any[]) =>
                this.dataService.product.searchProducts(this.searchTerm, ...args).refetchOnChannelChange(),
            (data) => data.search,
            // tslint:disable-next-line:no-shadowed-variable
            (skip, take) => ({
                input: {
                    skip,
                    take,
                    term: this.searchTerm,
                    facetValueIds: this.facetValueIds,
                    facetValueOperator: LogicalOperator.AND,
                    groupByProduct: this.groupByProduct,
                } as SearchInput,
            }),
        );
    }

    ngOnInit() {
        super.ngOnInit();
        this.facetValues$ = this.result$.pipe(map((data) => data.search.facetValues));
        // this.facetValues$ = of([]);
        this.route.queryParamMap
            .pipe(
                map((qpm) => qpm.get('q')),
                takeUntil(this.destroy$),
            )
            .subscribe((term) => {
                this.productSearchInput.setSearchTerm(term);
            });

        const fvids$ = this.route.queryParamMap.pipe(map((qpm) => qpm.getAll('fvids')));

        fvids$.pipe(takeUntil(this.destroy$)).subscribe((ids) => {
            this.productSearchInput.setFacetValues(ids);
        });

        this.facetValues$.pipe(take(1), delay(100), withLatestFrom(fvids$)).subscribe(([__, ids]) => {
            this.productSearchInput.setFacetValues(ids);
        });
    }

    setSearchTerm(term: string) {
        this.searchTerm = term;
        this.setQueryParam({ q: term || null, page: 1 });
        this.refresh();
    }

    setFacetValueIds(ids: string[]) {
        this.facetValueIds = ids;
        this.setQueryParam({ fvids: ids, page: 1 });
        this.refresh();
    }

    rebuildSearchIndex() {
        this.dataService.product.reindex().subscribe(({ reindex }) => {
            this.notificationService.info(_('catalog.reindexing'));
            this.jobQueueService.addJob(reindex.id, (job) => {
                if (job.state === JobState.COMPLETED) {
                    const time = new Intl.NumberFormat().format(job.duration || 0);
                    this.notificationService.success(_('catalog.reindex-successful'), {
                        count: job.result.indexedItemCount,
                        time,
                    });
                    this.refresh();
                } else {
                    this.notificationService.error(_('catalog.reindex-error'));
                }
            });
        });
    }

    async duplicateProduct(productId: string) {
        function duplicateTranslation(
            ti: any,
            defaultLanguageCode: LanguageCode,
            additionalFields?: string[],
        ) {
            if (Array.isArray(ti)) {
                return ti.map((e) => duplicateTranslation(e, defaultLanguageCode, additionalFields));
            }
            const ret = {
                languageCode: ti.languageCode == null ? defaultLanguageCode : ti.languageCode,
                name: ti.name,
            };
            additionalFields?.forEach((f) => (ret[f] = ti[f]));
            return ret;
        }
        function idArray(arr: any[]) {
            return arr?.map((e) => e.id);
        }

        const productQuery = await this.dataService.product.getProduct(productId).single$.toPromise();
        const oldProduct = productQuery.product;
        if (oldProduct == null) {
            return;
        }
        const pi = {
            featuredAssetId: oldProduct.featuredAsset?.id,
            assetIds: idArray(oldProduct.assets),
            facetValueIds: idArray(oldProduct.facetValues),
            translations: duplicateTranslation(oldProduct.translations, oldProduct.languageCode, [
                'slug',
                'description',
            ]),
        };
        const createProductResult = await this.dataService.product.createProduct(pi).toPromise();
        const newProduct: ProductWithVariantsFragment = createProductResult.createProduct;
        const dataService = this.dataService;
        async function duplicateProductOptionGroup(productVariants) {
            const productOptionGroupIds = {};
            const productOptionIds = {};
            productVariants.forEach((v) => {
                v.options.forEach((o) => {
                    productOptionGroupIds[o.groupId] = true;
                });
            });
            await Promise.all(
                Object.keys(productOptionGroupIds).map(async (groupId) => {
                    const pog = await dataService.product.getProductOptionGroup(groupId).single$.toPromise();
                    if (pog.productOptionGroup == null) {
                        return;
                    }
                    const oldOptionByCode = {};
                    pog.productOptionGroup.options.forEach((o) => (oldOptionByCode[o.code] = o.id));
                    const mut = await dataService.product
                        .createProductOptionGroups({
                            code: pog.productOptionGroup.code,
                            translations: duplicateTranslation(
                                pog.productOptionGroup.translations,
                                pog.productOptionGroup.languageCode,
                            ),
                            options: pog.productOptionGroup.options.map((opt) => {
                                return {
                                    code: opt.code,
                                    translations: duplicateTranslation(opt.translations, opt.languageCode),
                                };
                            }),
                        })
                        .toPromise();
                    productOptionGroupIds[groupId] = mut.createProductOptionGroup.id;
                    mut.createProductOptionGroup.options.forEach((o) => {
                        productOptionIds[oldOptionByCode[o.code]] = o.id;
                    });
                    return await dataService.product
                        .addOptionGroupToProduct({
                            productId: newProduct.id,
                            optionGroupId: mut.createProductOptionGroup.id,
                        })
                        .toPromise();
                }),
            );
            return productOptionIds;
        }
        const optionIdMapping = await duplicateProductOptionGroup(oldProduct.variants);
        const newVariants: CreateProductVariantInput[] = oldProduct.variants.map((v) => {
            return {
                productId: newProduct.id,
                translations: duplicateTranslation(v.translations, v.languageCode),
                facetValueIds: idArray(v.facetValues),
                sku: v.sku,
                price: v.price,
                taxCategoryId: v.taxCategory?.id,
                optionIds: v.options.map((o) => optionIdMapping[o.id]),
                featuredAssetId: v.featuredAsset?.id,
                assetIds: idArray(v.assets),
            };
        });
        const createProductVariantsResult = await this.dataService.product
            .createProductVariants(newVariants)
            .toPromise();
        return await this.router.navigate(['catalog', 'products', newProduct.id]);
    }

    deleteProduct(productId: string) {
        this.modalService
            .dialog({
                title: _('catalog.confirm-delete-product'),
                buttons: [
                    { type: 'secondary', label: _('common.cancel') },
                    { type: 'danger', label: _('common.delete'), returnValue: true },
                ],
            })
            .pipe(
                switchMap((response) =>
                    response ? this.dataService.product.deleteProduct(productId) : EMPTY,
                ),
            )
            .subscribe(
                () => {
                    this.notificationService.success(_('common.notify-delete-success'), {
                        entity: 'Product',
                    });
                    this.refresh();
                },
                (err) => {
                    this.notificationService.error(_('common.notify-delete-error'), {
                        entity: 'Product',
                    });
                },
            );
    }
}
