<?php

namespace Acme\DemoBundle\Controller;

final class PanelController
{
    public function show(string $section): string
    {
        return $section;
    }
}
