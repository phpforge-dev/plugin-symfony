<?php

use Symfony\Component\Routing\Loader\Configurator\RoutingConfigurator;

return static function (RoutingConfigurator $routes): void {
    $archive = $routes->collection('blog_archive_');
    $archive->add('list', '/')->methods(['GET']);
    $archive->add('year', '/{year}');
    $archive->prefix('/archive');

    $routes->collection('api_')->prefix('/api')->add('status', '/status')->methods(['GET']);

    $routes->import('shop/catalog.yaml')
        ->prefix('/shop')
        ->namePrefix('shop_');
};
