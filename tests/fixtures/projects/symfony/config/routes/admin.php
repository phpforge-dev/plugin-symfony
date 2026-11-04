<?php

use App\Controller\AdminController;
use Symfony\Component\Routing\Loader\Configurator\RoutingConfigurator;

return static function (RoutingConfigurator $routes): void {
    $routes->import('../../src/Controller/', 'attribute');

    $routes->add('admin_dashboard', '/admin')
        ->controller([AdminController::class, 'dashboard'])
        ->methods(['GET', 'HEAD']);

    $routes->add('admin_post_edit', '/admin/post/{id}')
        ->controller([AdminController::class, 'edit']);
};
