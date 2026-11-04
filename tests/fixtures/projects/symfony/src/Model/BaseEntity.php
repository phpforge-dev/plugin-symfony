<?php

namespace App\Model;

use Doctrine\ORM\Mapping as ORM;

#[ORM\MappedSuperclass]
abstract class BaseEntity
{
    #[ORM\Column(type: 'guid')]
    protected string $uuid = '';
}
